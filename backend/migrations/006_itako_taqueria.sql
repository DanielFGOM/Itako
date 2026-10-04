-- Itako Taquería: single-owner, single-location operating model.
-- All transactional data for the Itako location starts empty/zero.
-- Only the fixed catalog, package definitions and promotion rules are seeded.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS itako_mode boolean NOT NULL DEFAULT false;

ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS itako_promotion_code text;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS free_quantity integer NOT NULL DEFAULT 0;

ALTER TABLE public.itako_expenses
  ADD COLUMN IF NOT EXISTS business_date date;

UPDATE public.itako_expenses
SET business_date = (created_at AT TIME ZONE 'America/Mexico_City')::date
WHERE business_date IS NULL;

ALTER TABLE public.itako_expenses
  ALTER COLUMN business_date SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City')::date),
  ALTER COLUMN business_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS itako_expenses_location_business_date_idx
  ON public.itako_expenses(location_id, business_date DESC);

ALTER TABLE public.order_items
  DROP CONSTRAINT IF EXISTS order_items_free_quantity_check;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_free_quantity_check CHECK (free_quantity >= 0);

-- Cash-day ledger. One row per location and business date.
CREATE TABLE IF NOT EXISTS public.itako_cash_days (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    business_date date NOT NULL,
    opening_float_cents bigint NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
    next_day_float_cents bigint NOT NULL DEFAULT 0 CHECK (next_day_float_cents >= 0),
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_cash_days_pkey PRIMARY KEY (id),
    CONSTRAINT itako_cash_days_location_date_key UNIQUE (location_id, business_date)
);

CREATE TABLE IF NOT EXISTS public.itako_delivery_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    order_id uuid NOT NULL,
    business_date date NOT NULL,
    amount_cents bigint NOT NULL DEFAULT 1000 CHECK (amount_cents >= 0),
    paid_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_delivery_payouts_pkey PRIMARY KEY (id),
    CONSTRAINT itako_delivery_payouts_order_key UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS public.itako_employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    name text NOT NULL,
    phone text NOT NULL DEFAULT '',
    daily_pay_cents bigint NOT NULL DEFAULT 0 CHECK (daily_pay_cents >= 0),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_employees_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.itako_employee_work_days (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    work_date date NOT NULL,
    pay_cents bigint NOT NULL DEFAULT 0 CHECK (pay_cents >= 0),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_employee_work_days_pkey PRIMARY KEY (id),
    CONSTRAINT itako_employee_work_days_unique UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS public.itako_staff_consumptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    work_date date NOT NULL,
    employee_id uuid,
    item_id uuid,
    product_name_snapshot text NOT NULL,
    quantity numeric(10,3) NOT NULL CHECK (quantity > 0),
    unit_price_cents bigint NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_staff_consumptions_pkey PRIMARY KEY (id)
);

-- Package catalog. package_item_id points to a normal `items` row so the existing
-- POS pricing engine and order_items table remain the source of truth for money.
CREATE TABLE IF NOT EXISTS public.itako_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    package_item_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    normal_price_cents bigint NOT NULL DEFAULT 0 CHECK (normal_price_cents >= 0),
    package_price_cents bigint NOT NULL DEFAULT 0 CHECK (package_price_cents >= 0),
    sort_order integer NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_packages_pkey PRIMARY KEY (id),
    CONSTRAINT itako_packages_item_key UNIQUE (package_item_id)
);

CREATE TABLE IF NOT EXISTS public.itako_package_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    package_id uuid NOT NULL,
    item_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_package_components_pkey PRIMARY KEY (id),
    CONSTRAINT itako_package_components_unique UNIQUE (package_id, item_id)
);

-- RLS is location-scoped by the current organization, matching the existing Itako tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'itako_cash_days',
    'itako_delivery_payouts',
    'itako_employees',
    'itako_employee_work_days',
    'itako_staff_consumptions',
    'itako_packages',
    'itako_package_components'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS itako_cash_days_select ON public.itako_cash_days;
DROP POLICY IF EXISTS itako_cash_days_write ON public.itako_cash_days;
CREATE POLICY itako_cash_days_select ON public.itako_cash_days FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_cash_days_write ON public.itako_cash_days FOR ALL USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

DROP POLICY IF EXISTS itako_delivery_payouts_select ON public.itako_delivery_payouts;
DROP POLICY IF EXISTS itako_delivery_payouts_write ON public.itako_delivery_payouts;
CREATE POLICY itako_delivery_payouts_select ON public.itako_delivery_payouts FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_delivery_payouts_write ON public.itako_delivery_payouts FOR ALL USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

DROP POLICY IF EXISTS itako_employees_select ON public.itako_employees;
DROP POLICY IF EXISTS itako_employees_write ON public.itako_employees;
CREATE POLICY itako_employees_select ON public.itako_employees FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_employees_write ON public.itako_employees FOR ALL USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

DROP POLICY IF EXISTS itako_employee_work_days_select ON public.itako_employee_work_days;
DROP POLICY IF EXISTS itako_employee_work_days_write ON public.itako_employee_work_days;
CREATE POLICY itako_employee_work_days_select ON public.itako_employee_work_days FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_employee_work_days_write ON public.itako_employee_work_days FOR ALL USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

DROP POLICY IF EXISTS itako_staff_consumptions_select ON public.itako_staff_consumptions;
DROP POLICY IF EXISTS itako_staff_consumptions_write ON public.itako_staff_consumptions;
CREATE POLICY itako_staff_consumptions_select ON public.itako_staff_consumptions FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_staff_consumptions_write ON public.itako_staff_consumptions FOR ALL USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

DROP POLICY IF EXISTS itako_packages_select ON public.itako_packages;
DROP POLICY IF EXISTS itako_packages_write ON public.itako_packages;
-- The taquería owner can correct/delete local expense rows from the app.
DROP POLICY IF EXISTS itako_expenses_delete ON public.itako_expenses;
CREATE POLICY itako_expenses_delete ON public.itako_expenses FOR DELETE USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

CREATE POLICY itako_packages_select ON public.itako_packages FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_packages_write ON public.itako_packages FOR ALL USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);

DROP POLICY IF EXISTS itako_package_components_select ON public.itako_package_components;
DROP POLICY IF EXISTS itako_package_components_write ON public.itako_package_components;
CREATE POLICY itako_package_components_select ON public.itako_package_components FOR SELECT USING (
  package_id IN (SELECT id FROM public.itako_packages WHERE location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id()))
  OR public.is_service_role()
);
CREATE POLICY itako_package_components_write ON public.itako_package_components FOR ALL USING (
  package_id IN (SELECT id FROM public.itako_packages WHERE location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id()))
  OR public.is_service_role()
) WITH CHECK (
  package_id IN (SELECT id FROM public.itako_packages WHERE location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id()))
  OR public.is_service_role()
);

CREATE OR REPLACE FUNCTION public.itako_record_inventory_movement(
    p_location_id uuid,
    p_inventory_item_id uuid,
    p_movement_type text,
    p_quantity numeric,
    p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_stock numeric;
    v_new_stock numeric;
    v_allowed boolean;
BEGIN
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;
    v_allowed := p_movement_type IN ('compra','uso','merma');
    IF NOT v_allowed THEN
        RAISE EXCEPTION 'El movimiento de inventario no es válido.';
    END IF;

    SELECT current_stock INTO v_stock
    FROM public.inventory_items
    WHERE id = p_inventory_item_id AND location_id = p_location_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No se encontró el insumo.';
    END IF;

    IF p_movement_type = 'compra' THEN
        v_new_stock := v_stock + p_quantity;
    ELSE
        v_new_stock := v_stock - p_quantity;
        IF v_new_stock < 0 THEN
            RAISE EXCEPTION 'La cantidad no puede ser mayor que la existencia actual.';
        END IF;
    END IF;

    UPDATE public.inventory_items
       SET current_stock = v_new_stock, updated_at = timezone('utc'::text, now())
     WHERE id = p_inventory_item_id AND location_id = p_location_id;

    INSERT INTO public.itako_inventory_movements(
        location_id, inventory_item_id, movement_type, quantity, note, cost_cents
    )
    SELECT p_location_id, p_inventory_item_id, p_movement_type, p_quantity, p_note,
           round(COALESCE(cost_per_unit,0) * 100)::bigint
    FROM public.inventory_items
    WHERE id = p_inventory_item_id AND location_id = p_location_id;

    RETURN jsonb_build_object('id', p_inventory_item_id, 'current_stock', v_new_stock);
END;
$$;
GRANT EXECUTE ON FUNCTION public.itako_record_inventory_movement(uuid, uuid, text, numeric, text) TO authenticated;

-- Fixed single-user / single-location account. The existing authentication store
-- and password verification code are reused; only the allowed email is fixed.
DO $$
DECLARE
  v_user uuid := 'a7e0c0a0-8d54-4f06-9c7f-7b1b0f5b0001';
  v_org uuid := 'a7e0c0a0-8d54-4f06-9c7f-7b1b0f5b0002';
  v_loc uuid := 'a7e0c0a0-8d54-4f06-9c7f-7b1b0f5b0003';
  v_cat_tacos uuid;
  v_cat_gringas uuid;
  v_cat_quesadillas uuid;
  v_cat_kilo uuid;
  v_cat_bebidas uuid;
  v_cat_packages uuid;
  v_item_pastor uuid;
  v_item_asada uuid;
  v_item_cuerito uuid;
  v_item_longaniza uuid;
  v_item_chistorra uuid;
  v_item_quesadilla uuid;
  v_item_gringa uuid;
  v_item_pastor_half uuid;
  v_item_pastor_kg uuid;
  v_item_asada_half uuid;
  v_item_asada_kg uuid;
  v_item_coca uuid;
  v_item_coca3 uuid;
  v_item_agua uuid;
  v_item_jamaica uuid;
  v_item_horchata uuid;
  v_item_vaso uuid;
  v_pkg uuid;
BEGIN
  -- User: preserve existing row when the migration is rerun.
  INSERT INTO public.auth_users (id, email, password_hash, email_verified, raw_user_meta_data)
  VALUES (
    v_user,
    'Itakotaqueria@gmail.com',
    crypt('itako123', gen_salt('bf', 10)),
    true,
    jsonb_build_object('full_name', 'Itako Taquería', 'username', 'itako')
  )
  ON CONFLICT (email) DO UPDATE SET
    email_verified = true,
    password_hash = EXCLUDED.password_hash,
    raw_user_meta_data = EXCLUDED.raw_user_meta_data,
    updated_at = now();

  SELECT id INTO v_user FROM public.auth_users WHERE lower(email) = lower('Itakotaqueria@gmail.com');

  INSERT INTO public.organizations (id, name, is_active, default_currency_code, created_by)
  VALUES (v_org, 'Itako Taquería', true, 'MXN', v_user)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    is_active = true,
    default_currency_code = 'MXN';

  INSERT INTO public.organization_members (organization_id, profile_id, role, capabilities)
  VALUES (v_org, v_user, 'owner', '{}'::jsonb)
  ON CONFLICT (organization_id, profile_id) DO UPDATE SET archived_at = NULL, role = 'owner';

  INSERT INTO public.locations (
    id, organization_id, name, slug, description, country, currency_code,
    offers_delivery, offers_collection, accepts_delivery, accepts_pickup,
    on_delivery_payment_methods, delivery_fee, locale, timezone,
    tax_rate, tax_inclusive, tax_label, auto_gratuity_enabled, auto_gratuity_percent,
    is_marketplace_visible, is_active, itako_mode
  ) VALUES (
    v_loc, v_org, 'Itako', 'itako-taqueria', 'Taquería de un solo local', 'MX', 'MXN',
    true, true, true, true, ARRAY['cash_on_delivery','eft'], 10.00, 'es-MX', 'America/Mexico_City',
    0, true, 'Sin IVA', false, 0, false, true, true
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    country = 'MX', currency_code = 'MXN', offers_delivery = true, offers_collection = true,
    accepts_delivery = true, accepts_pickup = true, on_delivery_payment_methods = ARRAY['cash_on_delivery','eft'],
    delivery_fee = 10.00, locale = 'es-MX', timezone = 'America/Mexico_City',
    tax_rate = 0, tax_inclusive = true, tax_label = 'Sin IVA',
    auto_gratuity_enabled = false, auto_gratuity_percent = 0,
    is_marketplace_visible = false, is_active = true, itako_mode = true;

  -- Deactivate any old categories/items accidentally attached to this location.
  UPDATE public.categories SET is_active = false WHERE location_id = v_loc;
  UPDATE public.items SET is_active = false WHERE location_id = v_loc;

  INSERT INTO public.categories (location_id, organization_id, name, sort_order, is_active)
  VALUES (v_loc, v_org, 'Tacos', 10, true)
  ON CONFLICT (location_id, name) DO UPDATE SET is_active = true, sort_order = 10
  RETURNING id INTO v_cat_tacos;
  SELECT id INTO v_cat_tacos FROM public.categories WHERE location_id=v_loc AND name='Tacos';

  INSERT INTO public.categories (location_id, organization_id, name, sort_order, is_active)
  VALUES (v_loc, v_org, 'Gringas', 20, true)
  ON CONFLICT (location_id, name) DO UPDATE SET is_active = true, sort_order = 20;
  SELECT id INTO v_cat_gringas FROM public.categories WHERE location_id=v_loc AND name='Gringas';

  INSERT INTO public.categories (location_id, organization_id, name, sort_order, is_active)
  VALUES (v_loc, v_org, 'Quesadillas', 30, true)
  ON CONFLICT (location_id, name) DO UPDATE SET is_active = true, sort_order = 30;
  SELECT id INTO v_cat_quesadillas FROM public.categories WHERE location_id=v_loc AND name='Quesadillas';

  INSERT INTO public.categories (location_id, organization_id, name, sort_order, is_active)
  VALUES (v_loc, v_org, 'Por kilo', 40, true)
  ON CONFLICT (location_id, name) DO UPDATE SET is_active = true, sort_order = 40;
  SELECT id INTO v_cat_kilo FROM public.categories WHERE location_id=v_loc AND name='Por kilo';

  INSERT INTO public.categories (location_id, organization_id, name, sort_order, is_active)
  VALUES (v_loc, v_org, 'Bebidas', 50, true)
  ON CONFLICT (location_id, name) DO UPDATE SET is_active = true, sort_order = 50;
  SELECT id INTO v_cat_bebidas FROM public.categories WHERE location_id=v_loc AND name='Bebidas';

  INSERT INTO public.categories (location_id, organization_id, name, sort_order, is_active)
  VALUES (v_loc, v_org, 'Paquetes', 90, false)
  ON CONFLICT (location_id, name) DO UPDATE SET is_active = false, sort_order = 90;
  SELECT id INTO v_cat_packages FROM public.categories WHERE location_id=v_loc AND name='Paquetes';

  -- Menu items. No stock counters or sample transactions are created.
  -- The baseline schema has no unique key on (location_id,name), so we update
  -- existing catalog rows and insert only missing rows.
  UPDATE public.items SET category_id=v_cat_tacos, price=20, is_active=true, sort_order=10,
      recipe_type='simple', recipe_complexity='simple', itako_promotion_code='two_plus_one'
    WHERE location_id=v_loc AND name='Taco de pastor';
  IF NOT FOUND THEN
    INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity,itako_promotion_code)
    VALUES(v_loc,v_cat_tacos,'Taco de pastor',20,true,10,'simple','simple','two_plus_one');
  END IF;
  UPDATE public.items SET category_id=v_cat_tacos, price=20, is_active=true, sort_order=20, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Taco de asada';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_tacos,'Taco de asada',20,true,20,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_tacos, price=20, is_active=true, sort_order=30, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Taco de cuerito';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_tacos,'Taco de cuerito',20,true,30,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_tacos, price=20, is_active=true, sort_order=40, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Taco de longaniza';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_tacos,'Taco de longaniza',20,true,40,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_tacos, price=20, is_active=true, sort_order=50, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Taco de chistorra';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_tacos,'Taco de chistorra',20,true,50,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_quesadillas, price=20, is_active=true, sort_order=10, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Quesadilla';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_quesadillas,'Quesadilla',20,true,10,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_gringas, price=30, is_active=true, sort_order=10, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Gringa';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_gringas,'Gringa',30,true,10,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_kilo, price=125, is_active=true, sort_order=10, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Pastor — 1/2 kg';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_kilo,'Pastor — 1/2 kg',125,true,10,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_kilo, price=250, is_active=true, sort_order=20, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Pastor — 1 kg';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_kilo,'Pastor — 1 kg',250,true,20,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_kilo, price=200, is_active=true, sort_order=30, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Asada — 1/2 kg';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_kilo,'Asada — 1/2 kg',200,true,30,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_kilo, price=400, is_active=true, sort_order=40, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Asada — 1 kg';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_kilo,'Asada — 1 kg',400,true,40,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_bebidas, price=25, is_active=true, sort_order=10, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Coca-Cola';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_bebidas,'Coca-Cola',25,true,10,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_bebidas, price=60, is_active=true, sort_order=20, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Coca-Cola 3 L';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_bebidas,'Coca-Cola 3 L',60,true,20,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_bebidas, price=25, is_active=true, sort_order=30, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Agua';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_bebidas,'Agua',25,true,30,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_bebidas, price=25, is_active=true, sort_order=40, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Jamaica';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_bebidas,'Jamaica',25,true,40,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_bebidas, price=25, is_active=true, sort_order=50, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Horchata';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_bebidas,'Horchata',25,true,50,'simple','simple'); END IF;
  UPDATE public.items SET category_id=v_cat_bebidas, price=3, is_active=true, sort_order=60, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL WHERE location_id=v_loc AND name='Vaso desechable';
  IF NOT FOUND THEN INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity) VALUES(v_loc,v_cat_bebidas,'Vaso desechable',3,true,60,'simple','simple'); END IF;

  -- Resolve seeded item IDs.
  SELECT id INTO v_item_pastor FROM public.items WHERE location_id=v_loc AND name='Taco de pastor' LIMIT 1;
  SELECT id INTO v_item_asada FROM public.items WHERE location_id=v_loc AND name='Taco de asada' LIMIT 1;
  SELECT id INTO v_item_cuerito FROM public.items WHERE location_id=v_loc AND name='Taco de cuerito' LIMIT 1;
  SELECT id INTO v_item_longaniza FROM public.items WHERE location_id=v_loc AND name='Taco de longaniza' LIMIT 1;
  SELECT id INTO v_item_chistorra FROM public.items WHERE location_id=v_loc AND name='Taco de chistorra' LIMIT 1;
  SELECT id INTO v_item_quesadilla FROM public.items WHERE location_id=v_loc AND name='Quesadilla' LIMIT 1;
  SELECT id INTO v_item_gringa FROM public.items WHERE location_id=v_loc AND name='Gringa' LIMIT 1;
  SELECT id INTO v_item_pastor_half FROM public.items WHERE location_id=v_loc AND name='Pastor — 1/2 kg' LIMIT 1;
  SELECT id INTO v_item_pastor_kg FROM public.items WHERE location_id=v_loc AND name='Pastor — 1 kg' LIMIT 1;
  SELECT id INTO v_item_asada_half FROM public.items WHERE location_id=v_loc AND name='Asada — 1/2 kg' LIMIT 1;
  SELECT id INTO v_item_asada_kg FROM public.items WHERE location_id=v_loc AND name='Asada — 1 kg' LIMIT 1;
  SELECT id INTO v_item_coca FROM public.items WHERE location_id=v_loc AND name='Coca-Cola' LIMIT 1;
  SELECT id INTO v_item_coca3 FROM public.items WHERE location_id=v_loc AND name='Coca-Cola 3 L' LIMIT 1;
  SELECT id INTO v_item_agua FROM public.items WHERE location_id=v_loc AND name='Agua' LIMIT 1;
  SELECT id INTO v_item_jamaica FROM public.items WHERE location_id=v_loc AND name='Jamaica' LIMIT 1;
  SELECT id INTO v_item_horchata FROM public.items WHERE location_id=v_loc AND name='Horchata' LIMIT 1;
  SELECT id INTO v_item_vaso FROM public.items WHERE location_id=v_loc AND name='Vaso desechable' LIMIT 1;

  -- Only the confirmed customer package is active: 1 kg de pastor + Coca-Cola 3 L = $300.
  UPDATE public.items SET category_id=v_cat_packages, price=300, is_active=true, sort_order=10, recipe_type='simple', recipe_complexity='simple', itako_promotion_code=NULL
    WHERE location_id=v_loc AND name='Paquete Pastor Familiar';
  IF NOT FOUND THEN
    INSERT INTO public.items(location_id,category_id,name,price,is_active,sort_order,recipe_type,recipe_complexity)
    VALUES(v_loc,v_cat_packages,'Paquete Pastor Familiar',300,true,10,'simple','simple');
  END IF;

  -- Do not keep unconfirmed package proposals in the active Itako catalog.
  UPDATE public.items SET is_active=false WHERE location_id=v_loc AND name IN ('Paquete Asada Familiar','Paquete Mixto');
  DELETE FROM public.itako_package_components
   WHERE package_id IN (SELECT id FROM public.itako_packages WHERE location_id=v_loc AND name IN ('Paquete Asada Familiar','Paquete Mixto'));
  DELETE FROM public.itako_packages WHERE location_id=v_loc AND name IN ('Paquete Asada Familiar','Paquete Mixto');

  INSERT INTO public.itako_packages (location_id, package_item_id, name, description, normal_price_cents, package_price_cents, sort_order, is_active)
  SELECT v_loc, i.id, 'Paquete Pastor Familiar', '1 kg de pastor + Coca-Cola 3 L', 31000, 30000, 10, true
  FROM public.items i WHERE i.location_id=v_loc AND i.name='Paquete Pastor Familiar'
  ON CONFLICT (package_item_id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, normal_price_cents=EXCLUDED.normal_price_cents, package_price_cents=EXCLUDED.package_price_cents, is_active=true;

  DELETE FROM public.itako_package_components WHERE package_id IN (SELECT id FROM public.itako_packages WHERE location_id=v_loc);
  SELECT id INTO v_pkg FROM public.itako_packages WHERE location_id=v_loc AND name='Paquete Pastor Familiar';
  INSERT INTO public.itako_package_components(package_id,item_id,quantity) VALUES (v_pkg,v_item_pastor_kg,1),(v_pkg,v_item_coca3,1);
  -- Inventory: zero stock on first install, fixed units and supplied purchase costs.
  -- Existing stock is never reset when this migration is replayed.
  UPDATE public.inventory_items SET unit='kg', cost_per_unit=64.00 WHERE location_id=v_loc AND name='Carne de cerdo (pastor)';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Carne de cerdo (pastor)','kg',0,0,64.00); END IF;
  UPDATE public.inventory_items SET unit='kg', cost_per_unit=152.00 WHERE location_id=v_loc AND name='Carne de res (asada)';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Carne de res (asada)','kg',0,0,152.00); END IF;
  UPDATE public.inventory_items SET unit='kg' WHERE location_id=v_loc AND name='Tortilla';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Tortilla','kg',0,0,NULL); END IF;
  UPDATE public.inventory_items SET unit='piezas', cost_per_unit=46.00 WHERE location_id=v_loc AND name='Coca-Cola 3 L';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Coca-Cola 3 L','piezas',0,0,46.00); END IF;
  UPDATE public.inventory_items SET unit='L' WHERE location_id=v_loc AND name='Jamaica';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Jamaica','L',0,0,NULL); END IF;
  UPDATE public.inventory_items SET unit='L' WHERE location_id=v_loc AND name='Horchata';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Horchata','L',0,0,NULL); END IF;
  UPDATE public.inventory_items SET unit='piezas' WHERE location_id=v_loc AND name='Vasos desechables';
  IF NOT FOUND THEN INSERT INTO public.inventory_items(location_id,name,unit,current_stock,minimum_stock,cost_per_unit) VALUES(v_loc,'Vasos desechables','piezas',0,0,NULL); END IF;

  UPDATE public.locations SET itako_mode=true WHERE id=v_loc;
END $$;

-- Keep the seeded package item prices synchronized with the package table.
UPDATE public.items i
SET price = p.package_price_cents::numeric / 100.0,
    is_active = true
FROM public.itako_packages p
WHERE p.package_item_id = i.id
  AND p.location_id = i.location_id
  AND p.is_active = true;

CREATE INDEX IF NOT EXISTS itako_cash_days_location_date_idx ON public.itako_cash_days(location_id, business_date DESC);
CREATE INDEX IF NOT EXISTS itako_delivery_payouts_location_date_idx ON public.itako_delivery_payouts(location_id, business_date DESC);
CREATE INDEX IF NOT EXISTS itako_employee_work_days_location_date_idx ON public.itako_employee_work_days(location_id, work_date DESC);
CREATE INDEX IF NOT EXISTS itako_staff_consumptions_location_date_idx ON public.itako_staff_consumptions(location_id, work_date DESC);
CREATE INDEX IF NOT EXISTS itako_packages_location_sort_idx ON public.itako_packages(location_id, sort_order);

COMMENT ON COLUMN public.items.itako_promotion_code IS 'Itako-only POS promotion identifier. two_plus_one means every 2 paid units add 1 free unit.';
COMMENT ON COLUMN public.order_items.free_quantity IS 'Itako free units granted by an item promotion; quantity remains the billable/paid quantity.';
COMMENT ON TABLE public.itako_delivery_payouts IS 'The fixed $10 MXN paid to the delivery rider for each completed Itako delivery. It is not sales and is not stored in itako_expenses.';
