package main

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var collectionNames = map[string]bool{
	"profiles": true, "organization_members": true, "organizations": true, "locations": true,
	"categories": true, "items": true, "itako_packages": true, "itako_package_components": true,
	"orders": true, "order_items": true, "order_payments": true, "itako_expenses": true,
	"itako_employees": true, "itako_employee_work_days": true, "inventory_items": true,
	"itako_cash_days": true, "itako_staff_consumptions": true, "itako_delivery_payouts": true,
	"cash_drawers": true, "cash_drawer_sessions": true, "cash_drawer_movements": true,
}

func (a *App) data(w http.ResponseWriter, r *http.Request, c *Claims) {
	name := strings.TrimPrefix(r.URL.Path, "/data/")
	name = strings.Trim(name, "/")
	if !collectionNames[name] {
		errJSON(w, 404, "Recurso no encontrado.")
		return
	}
	col := a.db.Collection(name)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	switch r.Method {
	case http.MethodGet:
		a.dataGet(w, r, ctx, col)
	case http.MethodPost:
		if !writableCollections[name] {
			errJSON(w, http.StatusForbidden, "Operación no permitida.")
			return
		}
		a.dataInsert(w, r, ctx, col)
	case http.MethodPatch:
		if !writableCollections[name] {
			errJSON(w, http.StatusForbidden, "Operación no permitida.")
			return
		}
		a.dataUpdate(w, r, ctx, col)
	case http.MethodDelete:
		if !writableCollections[name] {
			errJSON(w, http.StatusForbidden, "Operación no permitida.")
			return
		}
		a.dataDelete(w, r, ctx, col)
	default:
		errJSON(w, 405, "Método no permitido")
	}
}

func parseFilters(q url.Values) bson.M {
	out := bson.M{}
	for _, op := range []string{"eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"} {
		for _, raw := range q[op] {
			p := strings.SplitN(raw, ",", 2)
			if len(p) != 2 {
				continue
			}
			col, val := p[0], p[1]
			switch op {
			case "eq":
				out[col] = parseValue(val)
			case "neq":
				out[col] = bson.M{"$ne": parseValue(val)}
			case "gt":
				out[col] = bson.M{"$gt": parseValue(val)}
			case "gte":
				out[col] = bson.M{"$gte": parseValue(val)}
			case "lt":
				out[col] = bson.M{"$lt": parseValue(val)}
			case "lte":
				out[col] = bson.M{"$lte": parseValue(val)}
			case "in":
				parts := strings.Split(val, ",")
				xs := make([]any, 0, len(parts))
				for _, x := range parts {
					xs = append(xs, parseValue(x))
				}
				out[col] = bson.M{"$in": xs}
			case "is":
				if val == "null" {
					out[col] = nil
				} else {
					out[col] = parseValue(val)
				}
			case "like", "ilike":
				out[col] = bson.M{"$regex": strings.ReplaceAll(strings.ReplaceAll(val, "%", ".*"), "_", "."), "$options": map[bool]string{true: "i", false: ""}[op == "ilike"]}
			}
		}
	}
	return out
}
func parseValue(v string) any {
	if v == "true" {
		return true
	}
	if v == "false" {
		return false
	}
	if v == "null" {
		return nil
	}
	if i, e := strconv.ParseInt(v, 10, 64); e == nil {
		return i
	}
	if f, e := strconv.ParseFloat(v, 64); e == nil {
		return f
	}
	return v
}
func projection(s string) bson.M {
	p := bson.M{}
	if s == "" || s == "*" {
		return p
	}
	for _, x := range strings.Split(s, ",") {
		x = strings.TrimSpace(x)
		if x != "" {
			p[x] = 1
		}
	}
	return p
}
func (a *App) dataGet(w http.ResponseWriter, r *http.Request, ctx context.Context, col *mongo.Collection) {
	q := r.URL.Query()
	filter := parseFilters(q)
	opts := options.Find().SetProjection(projection(q.Get("select")))
	if ord := q.Get("order"); ord != "" {
		parts := strings.Split(ord, ".")
		if len(parts) >= 1 {
			dir := 1
			if len(parts) > 1 && parts[1] == "desc" {
				dir = -1
			}
			opts.SetSort(bson.D{{Key: parts[0], Value: dir}})
		}
	}
	if lim, _ := strconv.ParseInt(q.Get("limit"), 10, 64); lim > 0 {
		opts.SetLimit(lim)
	}
	cur, e := col.Find(ctx, filter, opts)
	if e != nil {
		errJSON(w, 500, "No se pudo consultar la información.")
		return
	}
	defer cur.Close(ctx)
	rows := []DataDoc{}
	if e = cur.All(ctx, &rows); e != nil {
		errJSON(w, 500, "No se pudo leer la información.")
		return
	}
	for _, row := range rows {
		normalizeDoc(row)
	}
	if q.Get("single") == "true" {
		if len(rows) == 0 {
			errJSON(w, 404, "No se encontró la información solicitada.")
			return
		}
		writeJSON(w, 200, rows[0])
		return
	}
	writeJSON(w, 200, rows)
}
func (a *App) dataInsert(w http.ResponseWriter, r *http.Request, ctx context.Context, col *mongo.Collection) {
	var body any
	if decode(r, &body) != nil {
		errJSON(w, 400, "Solicitud inválida")
		return
	}
	docs := []DataDoc{}
	switch x := body.(type) {
	case map[string]any:
		docs = []DataDoc{x}
	case []any:
		for _, v := range x {
			if d, ok := v.(map[string]any); ok {
				docs = append(docs, d)
			}
		}
	default:
		errJSON(w, 400, "Datos inválidos")
		return
	}
	out := make([]DataDoc, 0, len(docs))
	for _, d := range docs {
		if d["id"] == nil {
			d["id"] = id()
		}
		d["created_at"] = first(d["created_at"], now())
		d["updated_at"] = now()
		if _, e := col.InsertOne(ctx, d); e != nil {
			errJSON(w, 409, "No se pudo guardar la información.")
			return
		}
		out = append(out, d)
	}
	if len(out) == 1 {
		writeJSON(w, 201, out[0])
	} else {
		writeJSON(w, 201, out)
	}
}
func first(a, b any) any {
	if a == nil || a == "" {
		return b
	}
	return a
}
func (a *App) dataUpdate(w http.ResponseWriter, r *http.Request, ctx context.Context, col *mongo.Collection) {
	var changes DataDoc
	if decode(r, &changes) != nil {
		errJSON(w, 400, "Solicitud inválida")
		return
	}
	delete(changes, "_id")
	changes["updated_at"] = now()
	res, e := col.UpdateMany(ctx, parseFilters(r.URL.Query()), bson.M{"$set": changes})
	if e != nil {
		errJSON(w, 500, "No se pudo actualizar la información.")
		return
	}
	if r.URL.Query().Get("single") == "true" {
		var row DataDoc
		if e = col.FindOne(ctx, parseFilters(r.URL.Query())).Decode(&row); e != nil {
			errJSON(w, 404, "No se encontró la información solicitada.")
			return
		}
		normalizeDoc(row)
		writeJSON(w, 200, row)
		return
	}
	writeJSON(w, 200, map[string]any{"updated": res.ModifiedCount})
}
func (a *App) dataDelete(w http.ResponseWriter, r *http.Request, ctx context.Context, col *mongo.Collection) {
	res, e := col.DeleteMany(ctx, parseFilters(r.URL.Query()))
	if e != nil {
		errJSON(w, 500, "No se pudo eliminar la información.")
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": res.DeletedCount})
}
func normalizeDoc(d DataDoc) {
	delete(d, "_id")
	if t, ok := d["created_at"].(time.Time); ok {
		d["created_at"] = t.Format(time.RFC3339)
	}
	if t, ok := d["updated_at"].(time.Time); ok {
		d["updated_at"] = t.Format(time.RFC3339)
	}
}

func (a *App) inventoryMovement(w http.ResponseWriter, r *http.Request, c *Claims) {
	if r.Method != "POST" {
		errJSON(w, 405, "Método no permitido")
		return
	}
	var in struct {
		LocationID      string  `json:"p_location_id"`
		InventoryItemID string  `json:"p_inventory_item_id"`
		MovementType    string  `json:"p_movement_type"`
		Quantity        float64 `json:"p_quantity"`
	}
	if decode(r, &in) != nil || in.LocationID == "" || in.InventoryItemID == "" || in.Quantity <= 0 {
		errJSON(w, 400, "Datos de movimiento inválidos.")
		return
	}
	delta := in.Quantity
	if in.MovementType != "compra" {
		delta = -delta
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	filter := bson.M{"id": in.InventoryItemID, "location_id": in.LocationID}
	var item DataDoc
	if e := a.db.Collection("inventory_items").FindOne(ctx, filter).Decode(&item); e != nil {
		errJSON(w, 404, "No se encontró el producto de inventario.")
		return
	}
	stock := numberFloat(item["current_stock"])
	next := stock + delta
	if next < 0 {
		errJSON(w, 400, "La cantidad no puede superar la existencia actual.")
		return
	}
	_, e := a.db.Collection("inventory_items").UpdateOne(ctx, filter, bson.M{"$set": bson.M{"current_stock": next, "updated_at": now()}})
	if e != nil {
		errJSON(w, 500, "No se pudo registrar el movimiento.")
		return
	}
	_, _ = a.db.Collection("inventory_movements").InsertOne(ctx, bson.M{"id": id(), "location_id": in.LocationID, "inventory_item_id": in.InventoryItemID, "movement_type": in.MovementType, "quantity": in.Quantity, "created_at": now()})
	writeJSON(w, 200, map[string]any{"current_stock": next})
}

func numberFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int32:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	default:
		return 0
	}
}

// keep sort imported for stable compilation if the server later adds secondary ordering.
var _ = sort.Slice

var writableCollections = map[string]bool{
	"items":                    true,
	"orders":                   true,
	"itako_expenses":           true,
	"itako_employees":          true,
	"itako_employee_work_days": true,
	"inventory_items":          true,
	"itako_cash_days":          true,
	"itako_staff_consumptions": true,
}
