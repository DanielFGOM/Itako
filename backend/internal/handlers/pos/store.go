package pos

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"github.com/beepbite/backend/internal/bizday"
	"github.com/beepbite/backend/internal/db"
	"github.com/beepbite/backend/internal/locations"
	"github.com/beepbite/backend/internal/money"
	"github.com/beepbite/backend/internal/payments"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors returned by Store and mapped to HTTP status codes by Handler.
var (
	ErrLocationNotFound         = errors.New("location not found")
	ErrItemNotFound             = errors.New("one or more items not found")
	ErrBadVariation             = errors.New("one or more variation option IDs are invalid")
	ErrBadModifier              = errors.New("one or more modifier IDs are invalid or do not belong to the requested item")
	ErrOrderNotFound            = errors.New("order not found")
	ErrOrderAlreadyPaid         = errors.New("order already paid")
	ErrPaymentMethodNotFound    = errors.New("payment method not found")
	ErrNoPaymentMethodAvailable = errors.New("no payment method available")
	ErrItemSoldOut              = errors.New("item sold out for today")
)

const kdsItemRoutesCTE = `
	WITH item_routes AS (
		SELECT
			oi.id AS order_item_id,
			oi.item_id,
			oi.quantity,
			oi.special_instructions,
			COALESCE(
				(SELECT isr.station_id
				   FROM item_station_routing isr
				  WHERE isr.item_id = oi.item_id
				  ORDER BY isr.is_primary DESC
				  LIMIT 1),
				(SELECT csr.station_id
				   FROM category_station_routing csr
				   JOIN items it ON it.id = oi.item_id
				  WHERE csr.category_id = it.category_id
				  ORDER BY csr.is_primary DESC
				  LIMIT 1),
				(SELECT ks.id
				   FROM kitchen_stations ks
				   JOIN items it2 ON it2.id = oi.item_id
				  WHERE ks.location_id = it2.location_id
				    AND ks.is_active
				  ORDER BY ks.sort_order ASC, ks.created_at ASC
				  LIMIT 1)
			) AS station_id
		FROM order_items oi
		WHERE oi.order_id = $1
	)`

const kdsStationDiscoverySQL = kdsItemRoutesCTE + `
	SELECT DISTINCT station_id
	FROM item_routes
	WHERE station_id IS NOT NULL`

const kdsTicketItemsInsertSQL = kdsItemRoutesCTE + `
	INSERT INTO kds_ticket_items (ticket_id, order_item_id, quantity, item_status, notes)
	SELECT $2, ir.order_item_id, ir.quantity, 'fired', ir.special_instructions
	FROM item_routes ir
	WHERE ir.station_id = $3
	ON CONFLICT (ticket_id, order_item_id) DO NOTHING
	RETURNING id`

// Store holds the pgx pool for POS order operations.
type Store struct {
	pool    *pgxpool.Pool
	gateway payments.PaymentProvider
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

type ModifierSelection struct {
	ModifierID string `json:"modifier_id"`
}

type OrderLineInput struct {
	ItemID             string              `json:"item_id"`
	Quantity           int                 `json:"quantity"`
	FreeQuantity       int                 `json:"free_quantity"`
	VariationOptionIDs []string            `json:"variation_option_ids"`
	Notes              string              `json:"notes"`
	CourseID           string              `json:"course_id"`
	Modifiers          []ModifierSelection `json:"modifiers"`
}

// CreatedOrder is the response returned after successfully creating an order.
//
// ARREGLADO: se agregó el campo DeliveryFeeMinor para que coincida con el uso
// en CreateOrder más abajo (línea ~625 del original).
type CreatedOrder struct {
	OrderID     string `json:"order_id"`
	OrderNumber string `json:"order_number"`

	SubtotalMinor    int64 `json:"subtotal_minor"`
	TaxMinor         int64 `json:"tax_minor"`
	GratuityMinor    int64 `json:"gratuity_minor"`
	TotalMinor       int64 `json:"total_minor"`
	DeliveryFeeMinor int64 `json:"delivery_fee_minor"` // ARREGLADO

	Subtotal    float64 `json:"subtotal"`
	Tax         float64 `json:"tax"`
	Gratuity    float64 `json:"gratuity"`
	Total       float64 `json:"total"`
	DeliveryFee float64 `json:"delivery_fee"`

	CurrencyCode     string `json:"currency_code"`
	CurrencyDecimals int    `json:"currency_decimals"`

	TaxRate      float64 `json:"tax_rate"`
	TaxInclusive bool    `json:"tax_inclusive"`
	TaxLabel     string  `json:"tax_label"`

	KDSTicketIDs  []string `json:"kds_ticket_ids"`
	Status        string   `json:"status"`
	PaymentMethod string   `json:"payment_method"`
}

func (s *Store) CreateOrder(
	ctx context.Context,
	locationID string,
	orderType string,
	tableNumber string,
	tableSessionID string,
	registerSessionID string,
	customerID string,
	lines []OrderLineInput,
	onDeliveryMethod string,
	customerNote string,
	partySize int,
) (*CreatedOrder, error) {
	scope := db.ScopeFromContext(ctx)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := setTxScope(ctx, tx, scope); err != nil {
		return nil, err
	}

	var orgID *string
	var onDeliveryMethods []string
	var autoGratuityEnabled bool
	var autoGratuityPercent float64
	var autoGratuityMinParty int
	var itakoMode bool
	if err := tx.QueryRow(ctx,
		`SELECT organization_id, on_delivery_payment_methods,
		        COALESCE(auto_gratuity_enabled, false),
		        COALESCE(auto_gratuity_percent, 0),
		        COALESCE(auto_gratuity_min_party, 0),
		        COALESCE(itako_mode, false)
		 FROM locations WHERE id = $1`,
		locationID,
	).Scan(&orgID, &onDeliveryMethods,
		&autoGratuityEnabled, &autoGratuityPercent, &autoGratuityMinParty, &itakoMode,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrLocationNotFound
		}
		return nil, err
	}
	if orgID == nil {
		return nil, ErrLocationNotFound
	}

	initialStatus := "confirmed"
	initialPaymentMethod := "cash"

	hasActiveCredential := s.gateway != nil

	if !hasActiveCredential && orderType == "delivery" {
		if len(onDeliveryMethods) == 0 {
			return nil, ErrNoPaymentMethodAvailable
		}
		initialStatus = "pending_on_delivery"
		switch onDeliveryMethod {
		case "card_machine":
			initialPaymentMethod = "card_on_delivery"
		default:
			initialPaymentMethod = "cash_on_delivery"
		}
	}

	type itemRow struct {
		id               string
		price            float64
		name             string
		promotionCode    *string
		dailyQuantity    *int
		dailySoldCount   int
		dailyCounterDate *string
	}
	settings, err := locations.SettingsFor(ctx, s.pool, locationID)
	if err != nil {
		return nil, fmt.Errorf("resolving location settings: %w", err)
	}
	cur := settings.Currency

	itemCache := make(map[string]itemRow, len(lines))
	for _, line := range lines {
		if _, cached := itemCache[line.ItemID]; cached {
			continue
		}
		var ir itemRow
		err := tx.QueryRow(ctx,
			`SELECT id, price, name, itako_promotion_code,
			        daily_quantity, daily_sold_count, daily_counter_date::text
			 FROM items WHERE id = $1`, line.ItemID,
		).Scan(&ir.id, &ir.price, &ir.name, &ir.promotionCode,
			&ir.dailyQuantity, &ir.dailySoldCount, &ir.dailyCounterDate)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrItemNotFound
		}
		if err != nil {
			return nil, err
		}
		itemCache[line.ItemID] = ir
	}

	type resolvedModifier struct {
		modifierID      string
		name            string
		priceDeltaCents int64
	}
	lineUnitCents := make([]int64, len(lines))
	lineModifiers := make([][]resolvedModifier, len(lines))

	for i, line := range lines {
		baseItem := itemCache[line.ItemID]
		if line.FreeQuantity < 0 {
			return nil, fmt.Errorf("free_quantity must be >= 0")
		}
		if line.FreeQuantity > 0 {
			if baseItem.promotionCode == nil || *baseItem.promotionCode != "two_plus_one" {
				return nil, fmt.Errorf("free_quantity is not valid for item %s", line.ItemID)
			}
			expectedFree := line.Quantity / 2
			if line.FreeQuantity != expectedFree {
				return nil, fmt.Errorf("invalid promotion quantity for item %s", line.ItemID)
			}
		}
		baseCents := int64(math.Round(baseItem.price * float64(money.Scale(cur.Decimals))))
		extra := int64(0)

		if len(line.Modifiers) > 0 {
			mods := make([]resolvedModifier, 0, len(line.Modifiers))
			for _, sel := range line.Modifiers {
				var rm resolvedModifier
				rm.modifierID = sel.ModifierID
				err := tx.QueryRow(ctx, `
					SELECT m.name, m.price_delta_cents
					FROM modifiers m
					JOIN modifier_groups mg ON mg.id = m.modifier_group_id
					WHERE m.id = $1
					  AND mg.item_id = $2
					  AND m.is_active = true
				`, sel.ModifierID, line.ItemID).Scan(&rm.name, &rm.priceDeltaCents)
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, fmt.Errorf("%w: modifier %s is not valid for item %s",
						ErrBadModifier, sel.ModifierID, line.ItemID)
				}
				if err != nil {
					return nil, fmt.Errorf("resolving modifier %s: %w", sel.ModifierID, err)
				}
				extra += rm.priceDeltaCents
				mods = append(mods, rm)
			}
			lineModifiers[i] = mods
		}

		lineUnitCents[i] = baseCents + extra
	}

	var subtotalCents int64
	for i, line := range lines {
		subtotalCents += lineUnitCents[i] * int64(line.Quantity)
	}

	// Itako prices are final menu prices. No IVA/tax is added or displayed.
	// Delivery is a fixed $10 MXN charge.
	var deliveryFeeCents int64
	if orderType == "delivery" {
		deliveryFeeCents = 1000
	}
	taxRate := float64(0)
	taxInclusive := true
	taxCents := int64(0)
	totalCents := subtotalCents + deliveryFeeCents

	var gratuityCents int64
	if false && autoGratuityEnabled && autoGratuityPercent > 0 && autoGratuityMinParty > 0 && partySize >= autoGratuityMinParty {
		gratuityBP := int64(math.Round(autoGratuityPercent * 100))
		gratuityCents = money.DivRound(subtotalCents*gratuityBP, 10000)
		totalCents += gratuityCents
	}

	businessDate := bizday.Date(time.Now(), settings.Zone())

	var maxSeq int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(
			CASE
				WHEN order_number ~ '^POS([0-9]+)$' THEN (regexp_replace(order_number, '^POS', ''))::int
				ELSE 0
			END
		), 0)
		FROM orders
		WHERE location_id = $1
		  AND business_date = $2::date
	`, locationID, businessDate).Scan(&maxSeq); err != nil {
		return nil, err
	}
	orderNumber := fmt.Sprintf("POS%04d", maxSeq+1)

	var notes any
	switch {
	case customerNote != "":
		notes = customerNote
	case tableNumber != "":
		notes = "Table: " + tableNumber
	}
	var orderID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO orders (
		    organization_id, location_id, customer_id, order_number,
		    order_type, fulfillment_type, status, table_session_id,
		    subtotal_cents, delivery_fee_cents, tax_cents, total_cents, tax_rate, tax_inclusive,
		    currency_code, estimated_prep_time, notes, gratuity_cents,
		    business_date
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 20, $16, $17, $18::date)
		RETURNING id
	`,
		*orgID, locationID, nullStr(customerID), orderNumber,
		orderType, fulfillmentTypeFor(orderType), initialStatus, nullStr(tableSessionID),
		subtotalCents, deliveryFeeCents, taxCents, totalCents, taxRate, taxInclusive,
		cur.Code, notes, gratuityCents,
		businessDate,
	).Scan(&orderID); err != nil {
		return nil, err
	}

	for i, line := range lines {
		unitCents := lineUnitCents[i]

		item := itemCache[line.ItemID]
		if item.dailyQuantity != nil {
			var remaining int
			servedQuantity := line.Quantity + line.FreeQuantity
			if err := tx.QueryRow(ctx, `
				UPDATE items
				SET daily_sold_count = CASE
				        WHEN daily_counter_date IS DISTINCT FROM $3::date
				        THEN $1
				        ELSE daily_sold_count + $1
				    END,
				    daily_counter_date = $3::date
				WHERE id = $2
				  AND daily_quantity IS NOT NULL
				RETURNING daily_quantity - CASE
				        WHEN (daily_counter_date IS DISTINCT FROM $3::date
				              OR daily_counter_date IS NULL)
				        THEN 0
				        ELSE daily_sold_count
				    END
			`, servedQuantity, line.ItemID, businessDate).Scan(&remaining); err != nil {
				return nil, fmt.Errorf("daily countdown for item %s: %w", line.ItemID, err)
			}
			if remaining < 0 {
				return nil, fmt.Errorf("%w: %q is sold out for today", ErrItemSoldOut, item.name)
			}
		}

		var orderItemID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO order_items (order_id, item_id, quantity, free_quantity, unit_price_cents, total_price_cents, special_instructions, course_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id
		`, orderID, line.ItemID, line.Quantity, line.FreeQuantity, unitCents, unitCents*int64(line.Quantity),
			nullStr(line.Notes), nullStr(line.CourseID),
		).Scan(&orderItemID); err != nil {
			return nil, err
		}

		for _, rm := range lineModifiers[i] {
			if _, err := tx.Exec(ctx, `
				INSERT INTO order_item_modifiers (order_item_id, modifier_id, price_cents_snapshot, name_snapshot)
				VALUES ($1, $2, $3, $4)
			`, orderItemID, rm.modifierID, rm.priceDeltaCents, rm.name,
			); err != nil {
				return nil, err
			}
		}
	}

	kdsTicketIDs := []string{}
	if !itakoMode {
		var fanoutErr error
		kdsTicketIDs, fanoutErr = fanoutInsideTx(ctx, tx, orderID)
		if fanoutErr != nil {
			qErr := db.WithTxServiceRole(ctx, tx, func() error {
				_, e := tx.Exec(ctx, `
				INSERT INTO kds_fanout_queue (order_id, error_message, retry_count, state)
				VALUES ($1, $2, 0, 'pending')
				ON CONFLICT (order_id) DO NOTHING
			`, orderID, fanoutErr.Error())
				return e
			})
			if qErr != nil {
				log.Printf("pos: fanout failed (%v) AND enqueue failed (%v) for order=%s — kitchen may miss this order", fanoutErr, qErr, orderID)
			}
			kdsTicketIDs = []string{}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	minorScale := float64(money.Scale(cur.Decimals))

	return &CreatedOrder{
		OrderID:     orderID,
		OrderNumber: orderNumber,

		SubtotalMinor:    subtotalCents,
		TaxMinor:         taxCents,
		GratuityMinor:    gratuityCents,
		TotalMinor:       totalCents,
		DeliveryFeeMinor: deliveryFeeCents, // ARREGLADO: campo agregado arriba

		Subtotal:    float64(subtotalCents) / minorScale,
		Tax:         float64(taxCents) / minorScale,
		Gratuity:    float64(gratuityCents) / minorScale,
		Total:       float64(totalCents) / minorScale,
		DeliveryFee: float64(deliveryFeeCents) / minorScale,

		CurrencyCode:     cur.Code,
		CurrencyDecimals: cur.Decimals,

		TaxRate:      taxRate,
		TaxInclusive: taxInclusive,
		TaxLabel:     "", // ARREGLADO: se quita taxCfg.EffectiveLabel() porque Itako no usa tax

		KDSTicketIDs:  kdsTicketIDs,
		Status:        initialStatus,
		PaymentMethod: initialPaymentMethod,
	}, nil
}

func fulfillmentTypeFor(orderType string) string {
	switch orderType {
	case "dine_in":
		return "dine_in"
	case "delivery":
		return "delivery"
	default:
		return "collection"
	}
}

func fanoutInsideTx(ctx context.Context, tx pgx.Tx, orderID string) ([]string, error) {
	var courseNumber *int
	err := tx.QueryRow(ctx,
		`SELECT course_number FROM orders WHERE id = $1`, orderID).Scan(&courseNumber)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("order not found for fanout")
	}
	if err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, kdsStationDiscoverySQL, orderID)
	if err != nil {
		return nil, err
	}
	var stations []string
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			rows.Close()
			return nil, err
		}
		stations = append(stations, sid)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var ticketIDs []string

	for _, stationID := range stations {
		var ticketNumber int
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(kt.ticket_number), 0) + 1
			FROM kds_tickets kt
			JOIN kitchen_stations ks ON ks.id = kt.station_id
			WHERE ks.location_id = (SELECT location_id FROM kitchen_stations WHERE id = $1)
		`, stationID).Scan(&ticketNumber); err != nil {
			return nil, err
		}

		var ticketID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO kds_tickets (
				order_id, station_id, ticket_number, status,
				course_number, priority
			) VALUES ($1, $2, $3, 'fired', $4, 0)
			ON CONFLICT (order_id, station_id) DO UPDATE
				SET updated_at = now()
			RETURNING id
		`, orderID, stationID, ticketNumber, courseNumber).Scan(&ticketID); err != nil {
			return nil, err
		}

		itemRows, err := tx.Query(ctx, kdsTicketItemsInsertSQL, orderID, ticketID, stationID)
		if err != nil {
			return nil, err
		}
		for itemRows.Next() {
			var discarded string
			if err := itemRows.Scan(&discarded); err != nil {
				itemRows.Close()
				return nil, err
			}
		}
		itemRows.Close()
		if err := itemRows.Err(); err != nil {
			return nil, err
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO kds_ticket_events (ticket_id, event_type)
			VALUES ($1, 'fired')
		`, ticketID); err != nil {
			return nil, err
		}

		ticketIDs = append(ticketIDs, ticketID)
	}

	return ticketIDs, nil
}

func (s *Store) GetOrderLocationID(ctx context.Context, orderID string) (string, error) {
	scope := db.ScopeFromContext(ctx)
	var locID string
	err := db.Scoped(ctx, s.pool, scope, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT location_id FROM orders WHERE id = $1`, orderID,
		).Scan(&locID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrOrderNotFound
	}
	return locID, err
}

func (s *Store) GetTableSessionLocationID(ctx context.Context, sessionID string) (string, error) {
	scope := db.ScopeFromContext(ctx)
	var locID string
	err := db.Scoped(ctx, s.pool, scope, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT location_id FROM table_sessions WHERE id = $1`, sessionID,
		).Scan(&locID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrOrderNotFound
	}
	return locID, err
}

func setTxScope(ctx context.Context, tx pgx.Tx, scope db.Scope) error {
	return db.ApplyScope(ctx, tx, scope)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
