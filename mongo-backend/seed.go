package main

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

func (a *App) ensureSchema(ctx context.Context) error {
	indexes := map[string][]mongo.IndexModel{
		"users":                    {{Keys: bson.D{{Key: "email", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"organization_members":     {{Keys: bson.D{{Key: "profile_id", Value: 1}, {Key: "organization_id", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"locations":                {{Keys: bson.D{{Key: "organization_id", Value: 1}, {Key: "is_active", Value: 1}}}},
		"categories":               {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "sort_order", Value: 1}}}},
		"items":                    {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "is_active", Value: 1}, {Key: "sort_order", Value: 1}}}},
		"orders":                   {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "business_date", Value: 1}, {Key: "created_at", Value: -1}}}},
		"order_items":              {{Keys: bson.D{{Key: "order_id", Value: 1}}}},
		"order_payments":           {{Keys: bson.D{{Key: "order_id", Value: 1}, {Key: "payment_status", Value: 1}}}},
		"itako_expenses":           {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "business_date", Value: 1}, {Key: "created_at", Value: -1}}}},
		"itako_employees":          {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "is_active", Value: 1}, {Key: "name", Value: 1}}}},
		"itako_employee_work_days": {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "work_date", Value: 1}, {Key: "employee_id", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"inventory_items":          {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "name", Value: 1}}}},
		"itako_cash_days":          {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "business_date", Value: 1}}, Options: options.Index().SetUnique(true)}},
		"itako_staff_consumptions": {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "work_date", Value: 1}, {Key: "created_at", Value: -1}}}},
		"itako_delivery_payouts":   {{Keys: bson.D{{Key: "location_id", Value: 1}, {Key: "business_date", Value: 1}}}},
	}
	for name, idx := range indexes {
		if _, e := a.db.Collection(name).Indexes().CreateMany(ctx, idx); e != nil {
			return e
		}
	}
	return nil
}

func (a *App) seed(ctx context.Context) error {
	// Seed only the non-financial master data allowed by the project requirements.
	user := DataDoc{"id": "itako-admin", "email": a.email, "password_hash": string(a.passwordHash), "email_verified": true, "created_at": time.Now().UTC()}
	org := DataDoc{"id": "itako-org", "slug": "itako", "name": "Itako Taquería", "is_active": true, "created_at": time.Now().UTC()}
	loc := DataDoc{"id": "itako-location", "organization_id": "itako-org", "slug": "itako", "name": "Itako Taquería", "is_active": true, "created_at": time.Now().UTC()}
	profile := DataDoc{"id": "itako-admin", "email": a.email, "full_name": "Administrador Itako", "username": "itako", "created_at": time.Now().UTC()}
	members := DataDoc{"id": "itako-member", "profile_id": "itako-admin", "organization_id": "itako-org", "created_at": time.Now().UTC()}
	for name, doc := range map[string]DataDoc{"users": user, "organizations": org, "locations": loc, "profiles": profile, "organization_members": members} {
		if err := upsertByID(ctx, a.db.Collection(name), doc); err != nil {
			return err
		}
	}
	cats := []struct {
		id, name string
		order    int
	}{{"cat-tacos", "Tacos", 10}, {"cat-gringas", "Gringas", 20}, {"cat-quesadillas", "Quesadillas", 30}, {"cat-kilo", "Por kilo", 40}, {"cat-bebidas", "Bebidas", 50}}
	for _, c := range cats {
		_ = upsertByID(ctx, a.db.Collection("categories"), DataDoc{"id": c.id, "location_id": "itako-location", "name": c.name, "sort_order": c.order, "is_active": true})
	}
	type prod struct {
		id, name, cat string
		price         float64
		promo         string
		order         int
	}
	products := []prod{
		{"taco-pastor", "Taco Pastor", "cat-tacos", 20, "two_plus_one", 10}, {"taco-asada", "Taco Asada", "cat-tacos", 20, "", 20}, {"taco-cuerito", "Taco Cuerito", "cat-tacos", 20, "", 30}, {"taco-longaniza", "Taco Longaniza", "cat-tacos", 20, "", 40}, {"taco-chistorra", "Taco Chistorra", "cat-tacos", 20, "", 50},
		{"gringa-pastor", "Gringa Pastor", "cat-gringas", 30, "", 60}, {"gringa-asada", "Gringa Asada", "cat-gringas", 35, "", 70}, {"gringa-longaniza", "Gringa Longaniza", "cat-gringas", 30, "", 80}, {"gringa-chistorra", "Gringa Chistorra", "cat-gringas", 30, "", 90},
		{"quesadilla", "Quesadilla", "cat-quesadillas", 20, "", 100},
		{"pastor-half", "Pastor 1/2 kg", "cat-kilo", 125, "", 110}, {"pastor-kg", "Pastor 1 kg", "cat-kilo", 250, "", 120}, {"asada-half", "Asada 1/2 kg", "cat-kilo", 200, "", 130}, {"asada-kg", "Asada 1 kg", "cat-kilo", 400, "", 140},
		{"agua-500", "Agua 500 ml", "cat-bebidas", 25, "", 150}, {"jamaica-500", "Jamaica 500 ml", "cat-bebidas", 25, "", 160}, {"coca-500", "Coca-Cola 500 ml", "cat-bebidas", 25, "", 170}, {"coca-3l", "Coca-Cola 3 L", "cat-bebidas", 60, "", 180},
		{"package-pastor", "Paquete Pastor", "cat-kilo", 300, "", 900}, {"package-asada", "Paquete Asada", "cat-kilo", 450, "", 910}, {"package-mixto", "Paquete Mixto", "cat-kilo", 370, "", 920},
	}
	for _, p := range products {
		doc := DataDoc{"id": p.id, "location_id": "itako-location", "category_id": p.cat, "name": p.name, "price": p.price, "is_active": true, "sort_order": p.order, "itako_promotion_code": nil, "recipe_type": "simple", "recipe_complexity": "simple"}
		if p.promo != "" {
			doc["itako_promotion_code"] = p.promo
		}
		if err := upsertByID(ctx, a.db.Collection("items"), doc); err != nil {
			return err
		}
	}
	packages := []struct {
		id, item, name, desc string
		price                int64
		order                int
	}{{"pkg-pastor", "package-pastor", "Paquete Pastor", "1 kg pastor + Coca-Cola 3 L", 30000, 1}, {"pkg-asada", "package-asada", "Paquete Asada", "1 kg asada + Coca-Cola 3 L", 45000, 2}, {"pkg-mixto", "package-mixto", "Paquete Mixto", "1/2 kg pastor + 1/2 kg asada + Coca-Cola 3 L", 37000, 3}}
	for _, p := range packages {
		if err := upsertByID(ctx, a.db.Collection("itako_packages"), DataDoc{"id": p.id, "location_id": "itako-location", "package_item_id": p.item, "name": p.name, "description": p.desc, "normal_price_cents": 0, "package_price_cents": p.price, "sort_order": p.order, "is_active": true}); err != nil {
			return err
		}
	}
	comps := []DataDoc{
		{"id": "pkg-pastor-c1", "package_id": "pkg-pastor", "item_id": "pastor-kg", "quantity": 1}, {"id": "pkg-pastor-c2", "package_id": "pkg-pastor", "item_id": "coca-3l", "quantity": 1},
		{"id": "pkg-asada-c1", "package_id": "pkg-asada", "item_id": "asada-kg", "quantity": 1}, {"id": "pkg-asada-c2", "package_id": "pkg-asada", "item_id": "coca-3l", "quantity": 1},
		{"id": "pkg-mixto-c1", "package_id": "pkg-mixto", "item_id": "pastor-half", "quantity": 1}, {"id": "pkg-mixto-c2", "package_id": "pkg-mixto", "item_id": "asada-half", "quantity": 1}, {"id": "pkg-mixto-c3", "package_id": "pkg-mixto", "item_id": "coca-3l", "quantity": 1},
	}
	for _, d := range comps {
		if err := upsertByID(ctx, a.db.Collection("itako_package_components"), d); err != nil {
			return err
		}
	}
	return nil
}
func upsertByID(ctx context.Context, c *mongo.Collection, d DataDoc) error {
	_, e := c.UpdateOne(ctx, bson.M{"id": d["id"]}, bson.M{"$set": d}, options.Update().SetUpsert(true))
	return e
}
