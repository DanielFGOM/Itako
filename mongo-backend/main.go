package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"golang.org/x/crypto/bcrypt"
)

type App struct {
	db           *mongo.Database
	jwtSecret    []byte
	email        string
	passwordHash []byte
	origin       string
	loginMu      sync.Mutex
	attempts     map[string][]time.Time
}

type Claims struct {
	jwt.RegisteredClaims
	Email string `json:"email"`
	Role  string `json:"role"`
}

type User struct {
	ID            string `bson:"id" json:"id"`
	Email         string `bson:"email" json:"email"`
	PasswordHash  string `bson:"password_hash" json:"-"`
	EmailVerified bool   `bson:"email_verified" json:"email_verified"`
}

type DataDoc map[string]any

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
func mustEnv(key string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		log.Fatalf("%s is required", key)
	}
	return v
}
func now() time.Time { return time.Now().UTC() }
func id() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return primitive.NewObjectID().Hex()
	}
	return hex.EncodeToString(b)
}
func cents(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int:
		return int64(x)
	case int64:
		return x
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func errJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	return d.Decode(v)
}

func main() {
	uri := mustEnv("MONGODB_URI")
	dbName := env("MONGODB_DATABASE", "itako")
	secret := mustEnv("JWT_SECRET")
	if len(secret) < 32 {
		log.Fatal("JWT_SECRET must contain at least 32 characters")
	}
	adminEmail := env("ITAKO_ADMIN_EMAIL", "Itakotaqueria@gmail.com")
	adminHash := strings.TrimSpace(os.Getenv("ITAKO_ADMIN_PASSWORD_HASH"))
	if adminHash == "" {
		if pw := os.Getenv("ITAKO_ADMIN_PASSWORD"); pw != "" {
			h, e := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
			if e != nil {
				log.Fatal(e)
			}
			adminHash = string(h)
		} else {
			log.Fatal("ITAKO_ADMIN_PASSWORD_HASH or ITAKO_ADMIN_PASSWORD is required")
		}
	}
	origin := env("CORS_ORIGINS", "http://localhost:5173")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri).SetServerSelectionTimeout(10*time.Second))
	if err != nil {
		log.Fatalf("mongo connect: %v", err)
	}
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pingCancel()
	if err = client.Ping(pingCtx, nil); err != nil {
		log.Fatalf("mongo ping: %v", err)
	}
	app := &App{db: client.Database(dbName), jwtSecret: []byte(secret), email: adminEmail, passwordHash: []byte(adminHash), origin: origin, attempts: map[string][]time.Time{}}
	if err = app.ensureSchema(context.Background()); err != nil {
		log.Fatalf("mongo schema: %v", err)
	}
	if err = app.seed(context.Background()); err != nil {
		log.Fatalf("mongo seed: %v", err)
	}

	mux := http.NewServeMux()
	app.routes(mux)
	staticDir := env("STATIC_DIR", filepath.Join("..", "web", "dist"))
	if _, e := os.Stat(staticDir); e == nil {
		mux.Handle("/", staticHandler(staticDir))
	}
	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: app.cors(mux), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	stop := make(chan os.Signal, 1)
	signalNotify(stop)
	go func() {
		<-stop
		shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(shutdownCtx)
		_ = client.Disconnect(shutdownCtx)
	}()
	log.Printf("Itako Mongo backend listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// Kept isolated so this file remains easy to compile on platforms where os/signal is unavailable in restricted tooling.
func signalNotify(ch chan<- os.Signal) {
	// imported lazily through a tiny helper in signal.go
	registerSignals(ch)
}

func (a *App) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if r.Header.Get("Origin") != "" && a.allowedOrigin(r.Header.Get("Origin")) {
			w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Actor-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) allowedOrigin(o string) bool {
	for _, x := range strings.Split(a.origin, ",") {
		if strings.TrimSpace(x) == o {
			return true
		}
	}
	return false
}

func (a *App) routes(m *http.ServeMux) {
	m.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "database": "mongodb"})
	})
	m.HandleFunc("/auth/signin", a.signin)
	m.HandleFunc("/auth/signout", a.authRequired(a.signout))
	m.HandleFunc("/auth/refresh", a.refresh)
	m.HandleFunc("/auth/me", a.authRequired(a.me))
	m.HandleFunc("/auth/signup", func(w http.ResponseWriter, r *http.Request) {
		errJSON(w, 403, "El registro de cuentas está deshabilitado para Itako.")
	})
	m.HandleFunc("/data/", a.authRequired(a.data))
	m.HandleFunc("/rpc/itako_record_inventory_movement", a.authRequired(a.inventoryMovement))
	m.HandleFunc("/pos/orders", a.authRequired(a.createOrder))
	m.HandleFunc("/pos/orders/", a.authRequired(a.posOrderSubroutes))
	m.HandleFunc("/orders/", a.authRequired(a.orderActions))
	m.HandleFunc("/cash-drawers/", a.authRequired(a.cashDrawerRoutes))
}

func (a *App) token(user User) (map[string]any, error) {
	nowt := now()
	exp := nowt.Add(12 * time.Hour)
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "itako", Subject: user.ID, ExpiresAt: jwt.NewNumericDate(exp), IssuedAt: jwt.NewNumericDate(nowt), Audience: []string{"itako"}}, Email: user.Email, Role: "owner"})
	s, e := t.SignedString(a.jwtSecret)
	if e != nil {
		return nil, e
	}
	return map[string]any{"access_token": s, "refresh_token": s, "expires_in": 43200, "user": map[string]any{"id": user.ID, "email": user.Email, "email_verified": user.EmailVerified}}, nil
}
func (a *App) parseToken(r *http.Request) (*Claims, error) {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(h, "Bearer ") {
		return nil, errors.New("missing token")
	}
	t, e := jwt.ParseWithClaims(strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")), &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("invalid signing method")
		}
		return a.jwtSecret, nil
	}, jwt.WithIssuer("itako"), jwt.WithAudience("itako"))
	if e != nil {
		return nil, e
	}
	c, ok := t.Claims.(*Claims)
	if !ok {
		return nil, errors.New("invalid claims")
	}
	return c, nil
}
func (a *App) authRequired(next func(http.ResponseWriter, *http.Request, *Claims)) {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := a.parseToken(r)
		if e != nil {
			errJSON(w, 401, "Sesión no válida o expirada.")
			return
		}
		next(w, r, c)
	})
}

func (a *App) signin(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errJSON(w, 405, "Método no permitido")
		return
	}
	var in struct{ Email, Password string }
	if decode(r, &in) != nil {
		errJSON(w, 400, "Solicitud inválida")
		return
	}
	email := strings.TrimSpace(strings.ToLower(in.Email))
	if !a.allowLogin(email) {
		errJSON(w, 429, "Demasiados intentos. Espera un momento.")
		return
	}
	if email != strings.ToLower(a.email) || bcrypt.CompareHashAndPassword(a.passwordHash, []byte(in.Password)) != nil {
		a.recordAttempt(email)
		errJSON(w, 401, "Correo o contraseña incorrectos.")
		return
	}
	u := User{ID: "itako-admin", Email: a.email, EmailVerified: true}
	tok, e := a.token(u)
	if e != nil {
		errJSON(w, 500, "No se pudo iniciar sesión.")
		return
	}
	writeJSON(w, 200, tok)
}
func (a *App) allowLogin(email string) bool {
	a.loginMu.Lock()
	defer a.loginMu.Unlock()
	cutoff := now().Add(-15 * time.Minute)
	xs := a.attempts[email]
	j := 0
	for _, t := range xs {
		if t.After(cutoff) {
			xs[j] = t
			j++
		}
	}
	a.attempts[email] = xs[:j]
	return len(xs) < 8
}
func (a *App) recordAttempt(email string) {
	a.loginMu.Lock()
	defer a.loginMu.Unlock()
	a.attempts[email] = append(a.attempts[email], now())
}
func (a *App) signout(w http.ResponseWriter, r *http.Request, c *Claims) {
	writeJSON(w, 200, map[string]any{"ok": true})
}
func (a *App) refresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	if decode(r, &in) != nil {
		errJSON(w, 400, "Solicitud inválida")
		return
	}
	req := r.Clone(r.Context())
	req.Header.Set("Authorization", "Bearer "+in.RefreshToken)
	c, e := a.parseToken(req)
	if e != nil {
		errJSON(w, 401, "Sesión expirada.")
		return
	}
	u := User{ID: c.Subject, Email: c.Email, EmailVerified: true}
	tok, e := a.token(u)
	if e != nil {
		errJSON(w, 500, "No se pudo renovar la sesión.")
		return
	}
	writeJSON(w, 200, tok)
}
func (a *App) me(w http.ResponseWriter, r *http.Request, c *Claims) {
	writeJSON(w, 200, map[string]any{"id": c.Subject, "email": c.Email, "email_verified": true})
}
