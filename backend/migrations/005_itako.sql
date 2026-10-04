-- Itako local adaptation
-- Final menu prices in MXN; no IVA/tax is added by the POS.
UPDATE public.locations
SET currency_code = 'MXN',
    tax_rate = 0,
    tax_inclusive = true,
    tax_label = 'Sin IVA',
    locale = 'es-MX',
    country = 'MX'
WHERE currency_code IS NULL OR currency_code <> 'MXN' OR tax_rate <> 0;

-- Disable automatic gratuity for Itako.
UPDATE public.locations
SET auto_gratuity_enabled = false, auto_gratuity_percent = 0, auto_gratuity_min_party = 0
WHERE auto_gratuity_enabled = true OR auto_gratuity_percent <> 0 OR auto_gratuity_min_party <> 0;

-- Simple internal expense ledger for Itako: meat, drinks, salaries, gas,
-- driver payouts and other operating costs.
CREATE TABLE IF NOT EXISTS public.itako_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    staff_id uuid,
    order_id uuid,
    category text NOT NULL,
    description text NOT NULL,
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    payment_method_code text NOT NULL DEFAULT 'cash',
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_expenses_pkey PRIMARY KEY (id),
    CONSTRAINT itako_expenses_payment_method_check CHECK (payment_method_code IN ('cash','eft'))
);
ALTER TABLE public.itako_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itako_expenses FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS itako_expenses_location_created_idx ON public.itako_expenses(location_id, created_at DESC);

DROP POLICY IF EXISTS itako_expenses_select ON public.itako_expenses;
DROP POLICY IF EXISTS itako_expenses_insert ON public.itako_expenses;
DROP POLICY IF EXISTS itako_expenses_update ON public.itako_expenses;
DROP POLICY IF EXISTS itako_expenses_delete ON public.itako_expenses;
CREATE POLICY itako_expenses_select ON public.itako_expenses FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_expenses_insert ON public.itako_expenses FOR INSERT WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_expenses_update ON public.itako_expenses FOR UPDATE USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
) WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_expenses_delete ON public.itako_expenses FOR DELETE USING (public.is_service_role());

-- Manual inventory history. Stock is kept on inventory_items; this table makes
-- every purchase/use/waste/manual adjustment visible and persistent.
CREATE TABLE IF NOT EXISTS public.itako_inventory_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    movement_type text NOT NULL,
    quantity numeric(10,3) NOT NULL CHECK (quantity > 0),
    note text,
    cost_cents bigint DEFAULT 0 NOT NULL CHECK (cost_cents >= 0),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT itako_inventory_movements_pkey PRIMARY KEY (id),
    CONSTRAINT itako_inventory_movements_type_check CHECK (movement_type IN ('compra','uso','merma','ajuste'))
);
ALTER TABLE public.itako_inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itako_inventory_movements FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS itako_inventory_movements_item_created_idx ON public.itako_inventory_movements(inventory_item_id, created_at DESC);
DROP POLICY IF EXISTS itako_inventory_movements_select ON public.itako_inventory_movements;
DROP POLICY IF EXISTS itako_inventory_movements_insert ON public.itako_inventory_movements;
CREATE POLICY itako_inventory_movements_select ON public.itako_inventory_movements FOR SELECT USING (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
CREATE POLICY itako_inventory_movements_insert ON public.itako_inventory_movements FOR INSERT WITH CHECK (
  location_id IN (SELECT id FROM public.locations WHERE organization_id = public.current_org_id())
  OR public.is_service_role()
);
