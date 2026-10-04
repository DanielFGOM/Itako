package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
)

type orderInput struct {
	LocationID        string `json:"location_id"`
	OrderType         string `json:"order_type"`
	RegisterSessionID string `json:"register_session_id"`
	TableNumber       string `json:"table_number"`
	Notes             string `json:"notes"`
	OnDeliveryMethod  string `json:"on_delivery_method"`
	Items             []struct {
		ItemID       string `json:"item_id"`
		Quantity     int64  `json:"quantity"`
		FreeQuantity int64  `json:"free_quantity"`
	} `json:"items"`
}
type orderItem struct {
	ID              string `bson:"id" json:"id"`
	OrderID         string `bson:"order_id" json:"order_id"`
	ItemID          string `bson:"item_id" json:"item_id"`
	Quantity        int64  `bson:"quantity" json:"quantity"`
	FreeQuantity    int64  `bson:"free_quantity" json:"free_quantity"`
	UnitPriceCents  int64  `bson:"unit_price_cents" json:"unit_price_cents"`
	TotalPriceCents int64  `bson:"total_price_cents" json:"total_price_cents"`
}

type itemDoc struct {
	ID         string  `bson:"id"`
	Name       string  `bson:"name"`
	Price      float64 `bson:"price"`
	Promo      string  `bson:"itako_promotion_code"`
	LocationID string  `bson:"location_id"`
	Active     bool    `bson:"is_active"`
}

func todayString() string        { return time.Now().Format("2006-01-02") }
func moneyCents(v float64) int64 { return int64(v*100 + 0.5) }
func (a *App) findItems(ctx context.Context, ids []string) (map[string]itemDoc, error) {
	m := map[string]itemDoc{}
	cur, e := a.db.Collection("items").Find(ctx, bson.M{"id": bson.M{"$in": ids}})
	if e != nil {
		return nil, e
	}
	defer cur.Close(ctx)
	for cur.Next(ctx) {
		var x itemDoc
		if e := cur.Decode(&x); e != nil {
			return nil, e
		}
		m[x.ID] = x
	}
	return m, nil
}
func calcLine(x itemDoc, q int64) (paid int64, free int64, total int64) {
	if q < 1 {
		return
	}
	free = 0
	if x.Promo == "two_plus_one" {
		free = q / 2
	}
	paid = moneyCents(x.Price) * q
	total = paid
	return
}
func gringaTotal(x itemDoc, q int64) int64 {
	unit := moneyCents(x.Price)
	if !strings.HasPrefix(strings.ToLower(x.Name), "gringa") {
		return unit * q
	}
	pair := int64(5000)
	if strings.Contains(strings.ToLower(x.Name), "asada") {
		pair = 6000
	}
	return (q/2)*pair + (q%2)*unit
}
func (a *App) createOrder(w http.ResponseWriter, r *http.Request, c *Claims) {
	if r.Method != "POST" {
		errJSON(w, 405, "Método no permitido")
		return
	}
	var in orderInput
	if decode(r, &in) != nil || in.LocationID == "" || len(in.Items) == 0 {
		errJSON(w, 400, "El pedido no es válido.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	ids := make([]string, 0, len(in.Items))
	for _, x := range in.Items {
		ids = append(ids, x.ItemID)
	}
	items, e := a.findItems(ctx, ids)
	if e != nil {
		errJSON(w, 500, "No se pudo consultar el menú.")
		return
	}
	subtotal := int64(0)
	lines := make([]orderItem, 0, len(in.Items))
	for _, x := range in.Items {
		it, ok := items[x.ItemID]
		if !ok || !it.Active {
			errJSON(w, 400, "Ese producto ya no está disponible.")
			return
		}
		if x.Quantity <= 0 {
			errJSON(w, 400, "La cantidad debe ser mayor que cero.")
			return
		}
		free := x.FreeQuantity
		if it.Promo == "two_plus_one" {
			free = x.Quantity / 2
		}
		line := gringaTotal(it, x.Quantity)
		if it.Promo == "two_plus_one" {
			line = moneyCents(it.Price) * x.Quantity
		}
		subtotal += line
		lines = append(lines, orderItem{ID: id(), ItemID: x.ItemID, Quantity: x.Quantity, FreeQuantity: free, UnitPriceCents: moneyCents(it.Price), TotalPriceCents: line})
	}
	delivery := int64(0)
	if in.OrderType == "delivery" {
		delivery = 1000
	}
	total := subtotal + delivery
	orderID := id()
	orderNumber := a.nextOrderNumber(ctx, in.LocationID)
	for i := range lines {
		lines[i].OrderID = orderID
		if _, e = a.db.Collection("order_items").InsertOne(ctx, lines[i]); e != nil {
			errJSON(w, 500, "No se pudo guardar el pedido.")
			return
		}
	}
	_, e = a.db.Collection("orders").InsertOne(ctx, bson.M{"id": orderID, "order_number": orderNumber, "location_id": in.LocationID, "order_type": in.OrderType, "status": "pending", "created_at": time.Now().UTC(), "business_date": todayString(), "subtotal_cents": subtotal, "delivery_fee_cents": delivery, "total_cents": total, "notes": in.Notes})
	if e != nil {
		errJSON(w, 500, "No se pudo guardar el pedido.")
		return
	}
	writeJSON(w, 201, map[string]any{"order_id": orderID, "order_number": orderNumber, "subtotal_minor": subtotal, "tax_minor": 0, "gratuity_minor": 0, "total_minor": total, "delivery_fee_minor": delivery, "subtotal": float64(subtotal) / 100, "tax": 0, "gratuity": 0, "total": float64(total) / 100, "delivery_fee": float64(delivery) / 100, "currency_code": "MXN", "currency_decimals": 2, "tax_rate": 0, "tax_inclusive": true, "tax_label": "", "kds_ticket_ids": []string{}, "status": "pending", "payment_method": ""})
}
func (a *App) nextOrderNumber(ctx context.Context, location string) string {
	n := time.Now().UnixNano() % 1000000
	return strconv.FormatInt(n, 10)
}
func (a *App) posOrderSubroutes(w http.ResponseWriter, r *http.Request, c *Claims) {
	path := strings.TrimPrefix(r.URL.Path, "/pos/orders/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 2 && parts[1] == "charge" && r.Method == "POST" {
		a.chargeOrder(w, r, c, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "items" && r.Method == "PATCH" {
		a.modifyOrder(w, r, c, parts[0])
		return
	}
	errJSON(w, 404, "Ruta no encontrada.")
}
func (a *App) modifyOrder(w http.ResponseWriter, r *http.Request, c *Claims, orderID string) {
	var in struct {
		Items []struct {
			ItemID       string `json:"item_id"`
			Quantity     int64  `json:"quantity"`
			FreeQuantity int64  `json:"free_quantity"`
		} `json:"items"`
	}
	if decode(r, &in) != nil || len(in.Items) == 0 {
		errJSON(w, 400, "El pedido no es válido.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var ord DataDoc
	if e := a.db.Collection("orders").FindOne(ctx, bson.M{"id": orderID}).Decode(&ord); e != nil {
		errJSON(w, 404, "No se encontró la orden.")
		return
	}
	if ord["status"] != "pending" {
		errJSON(w, 409, "Esta orden ya no se puede modificar.")
		return
	}
	_, _ = a.db.Collection("order_items").DeleteMany(ctx, bson.M{"order_id": orderID})
	ids := []string{}
	for _, x := range in.Items {
		ids = append(ids, x.ItemID)
	}
	its, e := a.findItems(ctx, ids)
	if e != nil {
		errJSON(w, 500, "No se pudo consultar el menú.")
		return
	}
	sub := int64(0)
	for _, x := range in.Items {
		it, ok := its[x.ItemID]
		if !ok {
			errJSON(w, 400, "No se encontró un producto.")
			return
		}
		free := x.FreeQuantity
		if it.Promo == "two_plus_one" {
			free = x.Quantity / 2
		}
		line := gringaTotal(it, x.Quantity)
		if it.Promo == "two_plus_one" {
			line = moneyCents(it.Price) * x.Quantity
		}
		sub += line
		_, e = a.db.Collection("order_items").InsertOne(ctx, orderItem{ID: id(), OrderID: orderID, ItemID: x.ItemID, Quantity: x.Quantity, FreeQuantity: free, UnitPriceCents: moneyCents(it.Price), TotalPriceCents: line})
		if e != nil {
			errJSON(w, 500, "No se pudo actualizar el pedido.")
			return
		}
	}
	delivery := int64(0)
	if ord["order_type"] == "delivery" {
		delivery = 1000
	}
	total := sub + delivery
	_, e = a.db.Collection("orders").UpdateOne(ctx, bson.M{"id": orderID}, bson.M{"$set": bson.M{"subtotal_cents": sub, "delivery_fee_cents": delivery, "total_cents": total, "updated_at": time.Now().UTC()}})
	if e != nil {
		errJSON(w, 500, "No se pudo actualizar el pedido.")
		return
	}
	writeJSON(w, 200, map[string]any{"order_id": orderID, "subtotal": float64(sub) / 100, "tax": 0, "total": float64(total) / 100, "delivery_fee": float64(delivery) / 100, "currency_code": "MXN", "kds_ticket_ids": []string{}})
}
func (a *App) chargeOrder(w http.ResponseWriter, r *http.Request, c *Claims, orderID string) {
	var in struct {
		PaymentMethodCode  string `json:"payment_method_code"`
		AmountPaidCents    int64  `json:"amount_paid_cents"`
		TipAmountCents     int64  `json:"tip_amount_cents"`
		ChangeGivenCents   int64  `json:"change_given_cents"`
		PaymentReference   string `json:"payment_reference"`
		ProcessedByStaffID string `json:"processed_by_staff_id"`
		Payments           []struct {
			PaymentMethodCode string `json:"payment_method_code"`
			AmountPaidCents   int64  `json:"amount_paid_cents"`
			TipAmountCents    int64  `json:"tip_amount_cents"`
			ChangeGivenCents  int64  `json:"change_given_cents"`
			PaymentReference  string `json:"payment_reference"`
		} `json:"payments"`
	}
	if decode(r, &in) != nil {
		errJSON(w, 400, "Datos de pago inválidos.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var ord DataDoc
	if e := a.db.Collection("orders").FindOne(ctx, bson.M{"id": orderID}).Decode(&ord); e != nil {
		errJSON(w, 404, "No se encontró la orden.")
		return
	}
	if ord["status"] == "completed" {
		errJSON(w, 409, "Esta orden ya fue cobrada.")
		return
	}
	total := cents(ord["total_cents"])
	legs := in.Payments
	if len(legs) == 0 {
		legs = []struct {
			PaymentMethodCode string `json:"payment_method_code"`
			AmountPaidCents   int64  `json:"amount_paid_cents"`
			TipAmountCents    int64  `json:"tip_amount_cents"`
			ChangeGivenCents  int64  `json:"change_given_cents"`
			PaymentReference  string `json:"payment_reference"`
		}{{in.PaymentMethodCode, in.AmountPaidCents, in.TipAmountCents, in.ChangeGivenCents, in.PaymentReference}}
	}
	if len(legs) == 0 || legs[0].PaymentMethodCode == "" {
		errJSON(w, 400, "La forma de pago no está disponible.")
		return
	}
	sum := int64(0)
	for _, p := range legs {
		if p.PaymentMethodCode != "cash" && p.PaymentMethodCode != "eft" && p.PaymentMethodCode != "transfer" {
			errJSON(w, 400, "La forma de pago no está disponible.")
			return
		}
		sum += p.AmountPaidCents - p.ChangeGivenCents
	}
	if sum < total {
		errJSON(w, 400, "El pago es menor al total.")
		return
	}
	tip := int64(0)
	change := int64(0)
	method := legs[0].PaymentMethodCode
	paid := int64(0)
	for _, p := range legs {
		paid += p.AmountPaidCents
		tip += p.TipAmountCents
		change += p.ChangeGivenCents
		_, e := a.db.Collection("order_payments").InsertOne(ctx, bson.M{"id": id(), "order_id": orderID, "payment_method_code": p.PaymentMethodCode, "amount_paid_cents": p.AmountPaidCents, "tip_amount_cents": p.TipAmountCents, "change_given_cents": p.ChangeGivenCents, "payment_reference": p.PaymentReference, "payment_status": "completed", "paid_at": time.Now().UTC()})
		if e != nil {
			errJSON(w, 500, "No se pudo registrar el pago.")
			return
		}
	}
	_, e := a.db.Collection("orders").UpdateOne(ctx, bson.M{"id": orderID}, bson.M{"$set": bson.M{"status": "completed", "updated_at": time.Now().UTC()}})
	if e != nil {
		errJSON(w, 500, "No se pudo cerrar la orden.")
		return
	}
	if ord["order_type"] == "delivery" {
		_, _ = a.db.Collection("itako_delivery_payouts").InsertOne(ctx, bson.M{"id": id(), "location_id": ord["location_id"], "order_id": orderID, "business_date": ord["business_date"], "amount_cents": 1000, "created_at": time.Now().UTC()})
	}
	writeJSON(w, 200, map[string]any{"order_id": orderID, "payment_id": id(), "payment_ids": []string{}, "payment_status": "completed", "session_closed": false, "paid_cents": paid, "change_cents": change, "tip_cents": tip, "method": method})
}

func (a *App) orderActions(w http.ResponseWriter, r *http.Request, c *Claims) {
	path := strings.TrimPrefix(r.URL.Path, "/orders/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) >= 2 && parts[1] == "mark-paid-on-delivery" {
		errJSON(w, 400, "Esta función no forma parte del flujo Itako.")
		return
	}
	if len(parts) == 2 && (parts[1] == "void" || parts[1] == "refund") && r.Method == "POST" {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		status := "cancelled"
		if parts[1] == "refund" {
			status = "refunded"
		}
		_, e := a.db.Collection("orders").UpdateOne(ctx, bson.M{"id": parts[0]}, bson.M{"$set": bson.M{"status": status, "updated_at": time.Now().UTC()}})
		if e != nil {
			errJSON(w, 500, "No se pudo actualizar la orden.")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	errJSON(w, 404, "Ruta no encontrada.")
}
