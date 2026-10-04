import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/services/supabase-client';
import { useAuth } from '@/context/auth-context';
import { chargeOrder } from '@/services/payment';
import { modifyOrder, submitPosOrder } from '@/services/pos';
import { X, Menu as MenuIcon, ReceiptText, WalletCards, Utensils, CreditCard, Package, Users, BarChart3, Plus, Minus, Trash2, Pencil, Download, Truck, Store, CalendarDays, ArrowLeft, Check, AlertCircle } from 'lucide-react';

const FIXED_DELIVERY_FEE = 10;
const PAYMENT_CASH = 'cash';
const PAYMENT_TRANSFER = 'eft';
const UNITS = ['Piezas', 'Kilogramos (kg)', 'Litros (L)', 'Paquete/Caja'] as const;
const EXPENSE_CATEGORIES = ['Renta', 'Gas', 'Compra de insumos', 'Sueldos', 'Otros'] as const;

type Page = 'inicio'|'orden'|'pedidos'|'caja'|'menu'|'gastos'|'inventario'|'empleados'|'ganancias';
type MenuCategory = 'Tacos'|'Gringas'|'Quesadillas'|'Por kilo'|'Bebidas';
type CategoryRow = { id:string; name:MenuCategory; sort_order:number };

type ItemRow = { id:string; name:string; price:number; category_id:string; categoryName:string; itako_promotion_code:string|null };
type CartLine = ItemRow & { quantity:number; isPackage?:boolean; packageId?:string; packageDescription?:string; };
type PackageRow = { id:string; package_item_id:string; name:string; description:string; normal_price_cents:number; package_price_cents:number; sort_order:number };
type PackageComponent = { package_id:string; item_id:string; quantity:number };
type OrderLine = { itemId:string; name:string; quantity:number; freeQuantity:number; unitPrice:number; lineTotal:number; servedQuantity:number };
type OrderRow = { id:string; order_number:string; order_type:string; status:string; created_at:string; business_date:string; subtotal:number; deliveryFee:number; total:number; paymentMethod:string|null; amountPaid:number; tip:number; change:number; cashInBox:number; deliveryPayout:number; lines:OrderLine[] };
type ExpenseRow = { id:string; category:string; description:string; amount:number; payment_method_code:string; created_at:string; business_date:string };
type Employee = { id:string; name:string; phone:string; daily_pay_cents:number; is_active:boolean };
type WorkDay = { employee_id:string; work_date:string; pay_cents:number };
type InventoryRow = { id:string; name:string; unit:string; current_stock:number; cost_per_unit:number|null };
type CashDay = { id:string; business_date:string; opening_float_cents:number; next_day_float_cents:number; closed_at:string|null };
type StaffConsumption = { id:string; employee_id:string|null; product_name_snapshot:string; quantity:number; work_date:string };

type CashModalProps = {
  total:number; orderId:string; orderType:string; subtotal:number;
  onClose:()=>void; onDone:()=>void;
};

const money = (n:number) => `$${Number(n||0).toLocaleString('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const lineTotal = (l:CartLine) => { const q=Math.max(0,Number(l.quantity||0)); if(l.categoryName==='Gringas'){ const pair=l.name.toLowerCase().includes('asada')?60:50; return Math.floor(q/2)*pair+(q%2)*Number(l.price||0); } return Number(l.price||0)*q; };
const cents = (n:number) => Math.round(Number(n||0)*100);
const friendlyError = (err:unknown) => { const m=err instanceof Error ? err.message : String(err||''); const x=m.toLowerCase(); if(x.includes('already paid')) return 'Esta orden ya fue cobrada.'; if(x.includes('not found')) return 'No se encontró la información solicitada.'; if(x.includes('sold out')) return 'Ese producto ya no está disponible.'; if(x.includes('invalid payment') || x.includes('payment method')) return 'La forma de pago no está disponible.'; if(x.includes('free_quantity')) return 'La promoción de pastor no tiene una cantidad válida.'; if(x.includes('cannot be modified')) return 'Esta orden ya no se puede editar.'; if(x.includes('existencia actual')) return 'La cantidad no puede superar la existencia actual.'; if(x.includes('cantidad debe ser mayor')) return 'La cantidad debe ser mayor que cero.'; return 'No se pudo completar la operación. Revisa la información e inténtalo de nuevo.'; };
const localDate = (d=new Date()) => {
  const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const prettyDate = (s:string) => new Intl.DateTimeFormat('es-MX',{day:'2-digit',month:'long',year:'numeric'}).format(new Date(`${s}T12:00:00`));
const mapStatus = (s:string) => s === 'completed' ? 'Cobrado' : s === 'cancelled' ? 'Cancelado' : 'Pendiente';
const mapType = (s:string) => s === 'delivery' ? 'Entrega' : 'Local';
const catLabel = (s:string) => ({'Tacos':'Tacos','Gringas':'Gringas','Quesadillas':'Quesadillas','Por kilo':'Por kilo','Bebidas':'Bebidas'} as Record<string,string>)[s] || s;
const unitToCode = (s:string) => ({'Piezas':'piezas','Kilogramos (kg)':'kg','Litros (L)':'L','Paquete/Caja':'paquete_caja'} as Record<string,string>)[s] || s;
const unitToLabel = (s:string) => ({'piezas':'Piezas','kg':'Kilogramos (kg)','L':'Litros (L)','paquete_caja':'Paquete/Caja'} as Record<string,string>)[s] || s;

function ErrBox({message}:{message:string}) {
  if (!message) return null;
  return <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0"/><span>{message}</span></div>;
}
function Empty({children}:{children:ReactNode}) { return <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">{children}</div>; }

export default function ItakoApp() {
  const { activeLocation, loading: authLoading } = useAuth();
  const [page,setPage]=useState<Page>('inicio');
  const [menuOpen,setMenuOpen]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [items,setItems]=useState<ItemRow[]>([]);
  const [categories,setCategories]=useState<CategoryRow[]>([]);
  const [packageItems,setPackageItems]=useState<ItemRow[]>([]);
  const [packages,setPackages]=useState<PackageRow[]>([]);
  const [components,setComponents]=useState<PackageComponent[]>([]);
  const [orders,setOrders]=useState<OrderRow[]>([]);
  const [expenses,setExpenses]=useState<ExpenseRow[]>([]);
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [workDays,setWorkDays]=useState<WorkDay[]>([]);
  const [inventory,setInventory]=useState<InventoryRow[]>([]);
  const [cashDay,setCashDay]=useState<CashDay|null>(null);
  const [consumptions,setConsumptions]=useState<StaffConsumption[]>([]);
  const [cart,setCart]=useState<CartLine[]>([]);
  const [orderType,setOrderType]=useState<'local'|'delivery'>('local');
  const [category,setCategory]=useState<MenuCategory>('Tacos');
  const [editingOrderId,setEditingOrderId]=useState<string|null>(null);
  const [today,setToday]=useState(localDate());
  const [refreshTick,setRefreshTick]=useState(0);

  const locationId = activeLocation?.id || '';

  const loadAll = useCallback(async () => {
    if (!locationId) return;
    setLoading(true); setError('');
    try {
      const [catRes,itemRes,pkgRes,compRes,orderRes,paymentRes,expenseRes,empRes,workRes,invRes,cashRes,consRes] = await Promise.all([
        supabase.from('categories').select('id,name,sort_order').eq('location_id',locationId).eq('is_active',true).order('sort_order'),
        supabase.from('items').select('id,name,price,category_id,itako_promotion_code,sort_order').eq('location_id',locationId).eq('is_active',true).order('sort_order'),
        supabase.from('itako_packages').select('*').eq('location_id',locationId).eq('is_active',true).order('sort_order'),
        supabase.from('itako_package_components').select('*'),
        supabase.from('orders').select('id,order_number,order_type,status,created_at,business_date,subtotal_cents,delivery_fee_cents,total_cents').eq('location_id',locationId).eq('business_date',today).order('created_at',{ascending:false}),
        supabase.from('order_payments').select('id,order_id,payment_method_code,amount_paid_cents,tip_amount_cents,change_given_cents,payment_status,paid_at').eq('payment_status','completed'),
        supabase.from('itako_expenses').select('*').eq('location_id',locationId).order('created_at',{ascending:false}),
        supabase.from('itako_employees').select('*').eq('location_id',locationId).eq('is_active',true).order('name'),
        supabase.from('itako_employee_work_days').select('*').eq('location_id',locationId),
        supabase.from('inventory_items').select('id,name,unit,current_stock,cost_per_unit').eq('location_id',locationId).order('name'),
        supabase.from('itako_cash_days').select('*').eq('location_id',locationId).eq('business_date',today).maybeSingle(),
        supabase.from('itako_staff_consumptions').select('*').eq('location_id',locationId).eq('work_date',today).order('created_at',{ascending:false}),
      ]);
      for (const r of [catRes,itemRes,pkgRes,compRes,orderRes,paymentRes,expenseRes,empRes,workRes,invRes,cashRes,consRes]) if (r.error) throw new Error(r.error.message);
      const categoryRows: CategoryRow[] = (catRes.data||[]).map((c:any)=>({id:c.id,name:c.name as MenuCategory,sort_order:Number(c.sort_order||0)}));
      setCategories(categoryRows);
      const cats = new Map(categoryRows.map((c)=>[c.id,c.name]));
      const packageItemIds = new Set((pkgRes.data||[]).map((x:any)=>x.package_item_id));
      const baseItems: ItemRow[] = (itemRes.data||[]).filter((r:any)=>!packageItemIds.has(r.id)).map((r:any)=>({id:r.id,name:r.name,price:Number(r.price||0),category_id:r.category_id,categoryName:String(cats.get(r.category_id)||''),itako_promotion_code:r.itako_promotion_code||null}));
      const pItems: ItemRow[] = (itemRes.data||[]).filter((r:any)=>packageItemIds.has(r.id)).map((r:any)=>({id:r.id,name:r.name,price:Number(r.price||0),category_id:r.category_id,categoryName:'Paquete',itako_promotion_code:null}));
      setItems(baseItems);
      setPackageItems(pItems);
      setPackages((pkgRes.data||[]) as PackageRow[]);
      setComponents((compRes.data||[]) as PackageComponent[]);
      const pm = new Map<string,any>((paymentRes.data||[]).map((p:any)=>[p.order_id,p]));
      const orderIds = (orderRes.data||[]).map((o:any)=>o.id);
      let orderItems:any[]=[];
      if(orderIds.length){
        const r = await supabase.from('order_items').select('id,order_id,item_id,quantity,free_quantity,unit_price_cents,total_price_cents').in('order_id',orderIds);
        if(r.error) throw new Error(r.error.message);
        orderItems=r.data||[];
      }
      const itemMap = new Map(baseItems.map(x=>[x.id,x]));
      // Package items are intentionally excluded from the normal menu filters.
      // They are kept separately so an exact product combination can be priced as a package.
      for (const pItem of pItems) itemMap.set(pItem.id, pItem);
      // Keep historical order lines readable even after a product is removed from the active menu.
      const missingItemIds = [...new Set(orderItems.map((oi:any)=>String(oi.item_id)))].filter(id=>!itemMap.has(id));
      if (missingItemIds.length) {
        const historyItems = await supabase.from('items').select('id,name,price,category_id,itako_promotion_code').eq('location_id',locationId).in('id',missingItemIds);
        if (historyItems.error) throw new Error(historyItems.error.message);
        for (const r of (historyItems.data||[])) itemMap.set(r.id,{id:r.id,name:r.name,price:Number(r.price||0),category_id:r.category_id,categoryName:String(cats.get(r.category_id)||'Producto'),itako_promotion_code:r.itako_promotion_code||null});
      }
      const grouped = new Map<string,any[]>(); for(const oi of orderItems){const a=grouped.get(oi.order_id)||[];a.push(oi);grouped.set(oi.order_id,a)}
      const mapped:OrderRow[]=(orderRes.data||[]).map((o:any)=>{
        const pay=pm.get(o.id); const lines=(grouped.get(o.id)||[]).map((oi:any)=>{const it=itemMap.get(oi.item_id);const q=Number(oi.quantity);const fq=Number(oi.free_quantity||0);return {itemId:oi.item_id,name:it?.name||'Producto',quantity:q,freeQuantity:fq,unitPrice:Number(oi.unit_price_cents||0)/100,lineTotal:Number(oi.total_price_cents||0)/100,servedQuantity:q+fq}});
        const delivery=Number(o.delivery_fee_cents||0)/100;
        const subtotal=Number(o.subtotal_cents||0)/100;
        const paid=pay?Number(pay.amount_paid_cents||0)/100:0;
        const tip=pay?Number(pay.tip_amount_cents||0)/100:0;
        const change=pay?Number(pay.change_given_cents||0)/100:0;
        const cash = pay?.payment_method_code===PAYMENT_CASH ? Math.max(0, subtotal) : 0;
        return {id:o.id,order_number:o.order_number,order_type:o.order_type,status:mapStatus(o.status),created_at:o.created_at,business_date:o.business_date,subtotal,deliveryFee:delivery,total:Number(o.total_cents||0)/100,paymentMethod:pay?.payment_method_code||null,amountPaid:paid,tip,change,cashInBox:cash,deliveryPayout:o.order_type==='delivery' && o.status==='completed'?FIXED_DELIVERY_FEE:0,lines};
      });
      setOrders(mapped);
      setExpenses((expenseRes.data||[]).map((x:any)=>({...x,amount:Number(x.amount_cents||0)/100})) as ExpenseRow[]);
      setEmployees((empRes.data||[]) as Employee[]);
      setWorkDays((workRes.data||[]) as WorkDay[]);
      setInventory((invRes.data||[]).map((x:any)=>({...x,current_stock:Number(x.current_stock||0),cost_per_unit:x.cost_per_unit==null?null:Number(x.cost_per_unit)})) as InventoryRow[]);
      setConsumptions((consRes.data||[]) as StaffConsumption[]);
      let cd=cashRes.data as CashDay|null;
      if(!cd){
        // Carry the previous day's reserved change float forward automatically.
        const prev = new Date(`${today}T12:00:00`); prev.setDate(prev.getDate()-1); const prevDate=localDate(prev);
        const prevR=await supabase.from('itako_cash_days').select('next_day_float_cents').eq('location_id',locationId).eq('business_date',prevDate).maybeSingle();
        if(prevR.error) throw new Error(prevR.error.message);
        const carried=Number(prevR.data?.next_day_float_cents||0);
        const createR=await supabase.from('itako_cash_days').insert({location_id:locationId,business_date:today,opening_float_cents:carried,next_day_float_cents:0}).select().single();
        if(createR.error) throw new Error(createR.error.message); cd=createR.data as CashDay;
      }
      setCashDay(cd);
    } catch(e:any){ setError(e?.message || 'No se pudieron cargar los datos.'); }
    finally{setLoading(false)}
  },[locationId,today,refreshTick]);

  useEffect(()=>{void loadAll()},[loadAll]);
  useEffect(()=>{ if(page==='caja') setToday(localDate()); },[page]);

  const refresh=()=>setRefreshTick(v=>v+1);
  const itemById=useMemo(()=>new Map(items.map(x=>[x.id,x])),[items]);
  const packageItemById=useMemo(()=>new Map(packageItems.map(x=>[x.id,x])),[packageItems]);

  const packageForCart = useCallback(() => {
    const remaining = new Map(cart.map(l=>[l.id,l.quantity]));
    const result: CartLine[]=[];
    const pkgRows = [...packages].sort((a,b)=>a.sort_order-b.sort_order);
    for(const pkg of pkgRows){
      const comps=components.filter(c=>c.package_id===pkg.id);
      if(!comps.length) continue;
      let count=Infinity;
      for(const c of comps) count=Math.min(count,Math.floor((remaining.get(c.item_id)||0)/c.quantity));
      if(!Number.isFinite(count)||count<=0) continue;
      for(const c of comps) remaining.set(c.item_id,(remaining.get(c.item_id)||0)-count*c.quantity);
      const pi=packageItemById.get(pkg.package_item_id);
      if(pi) result.push({...pi,quantity:count,isPackage:true,packageId:pkg.id,packageDescription:pkg.description});
    }
    for(const line of cart){ const q=remaining.get(line.id)||0; if(q>0) result.push({...line,quantity:q}); }
    return result;
  },[cart,packages,components,packageItemById]);

  const billLines=packageForCart();
  const subtotal = billLines.reduce((s,l)=>s+lineTotal(l),0);
  const deliveryFee=orderType==='delivery'&&billLines.length?FIXED_DELIVERY_FEE:0;
  const total=subtotal+deliveryFee;

  const addItem=(item:ItemRow)=>setCart(old=>{const f=old.find(x=>x.id===item.id);return f?old.map(x=>x.id===item.id?{...x,quantity:x.quantity+1}:x):[...old,{...item,quantity:1}]});
  const changeItem=(id:string,d:number)=>setCart(old=>old.flatMap(x=>x.id===id?({...x,quantity:x.quantity+d, ...(x.quantity+d<=0?{quantity:0}:{})}):x).filter(x=>x.quantity>0));

  const startEditingOrder=async(o:OrderRow)=>{
    try{
      setError('');
      const r=await supabase.from('order_items').select('item_id,quantity,free_quantity').eq('order_id',o.id); if(r.error) throw new Error(r.error.message);
      const loaded:CartLine[]=[];
      for(const oi of (r.data||[])){const it=itemById.get(oi.item_id)|| (await (async()=>{const x=await supabase.from('items').select('id,name,price,category_id,itako_promotion_code').eq('id',oi.item_id).single();if(x.error)throw new Error(x.error.message);return {...x.data,price:Number((x.data as any).price||0),categoryName:'Paquete'} as ItemRow})()); loaded.push({...it,quantity:Number(oi.quantity)});}
      setCart(loaded);setOrderType(o.order_type==='delivery'?'delivery':'local');setEditingOrderId(o.id);setPage('orden');
    }catch(e:any){setError(friendlyError(e));}
  };

  const syncOrderType=async(orderId:string)=>{
    const nextType=orderType==='delivery'?'delivery':'dine_in';
    const nextFee=orderType==='delivery'?cents(FIXED_DELIVERY_FEE):0;
    const r=await supabase.from('orders').update({order_type:nextType,delivery_fee_cents:nextFee}).eq('id',orderId).eq('location_id',locationId);
    if(r.error) throw new Error(r.error.message);
  };

  const saveOrder=async(shouldCharge=false, cashModal?:{cash:number;tip:number;change:number;method:string})=>{
    if(!locationId||!billLines.length)return;
    setLoading(true);setError('');
    try{
      const payload=billLines.map(l=>({item_id:l.id,quantity:l.quantity,free_quantity:l.itako_promotion_code==='two_plus_one'?Math.floor(l.quantity/2):0}));
      let orderId=editingOrderId;
      if(editingOrderId){await modifyOrder(editingOrderId,payload); await syncOrderType(editingOrderId);}
      else{const created=await submitPosOrder({locationId,orderType:orderType==='delivery'?'delivery':'dine_in',items:payload,notes:'',onDeliveryMethod:'cash'});orderId=created.order_id;}
      if(!orderId)throw new Error('No se pudo identificar la orden.');
      if(shouldCharge){
        if(!cashModal)throw new Error('Falta información del cobro.');
        await chargeOrder({orderId,paymentMethodCode:cashModal.method,amountPaidCents:cents(cashModal.cash),tipAmountCents:cents(cashModal.tip),changeGivenCents:cents(cashModal.change)});
      }
      setCart([]);setEditingOrderId(null);setOrderType('local');refresh();setPage(shouldCharge?'pedidos':'pedidos');
    }catch(e:any){setError(friendlyError(e));}
    finally{setLoading(false)}
  };

  const openCharge = async()=>{
    if(!billLines.length)return;
    // Create/update pending order first; the actual modal then charges that same persisted order.
    setLoading(true);setError('');
    try{
      const payload=billLines.map(l=>({item_id:l.id,quantity:l.quantity,free_quantity:l.itako_promotion_code==='two_plus_one'?Math.floor(l.quantity/2):0}));
      let id=editingOrderId;
      let orderNumber=editingOrderId ? (orders.find(x=>x.id===editingOrderId)?.order_number||'') : '';
      let createdOrder:any=null;
      if(id){ await modifyOrder(id,payload); await syncOrderType(id); } else {createdOrder=await submitPosOrder({locationId,orderType:orderType==='delivery'?'delivery':'dine_in',items:payload,onDeliveryMethod:'cash'});id=createdOrder.order_id;orderNumber=createdOrder.order_number||'';}
      if(!id)throw new Error('No se pudo crear la orden.');
      const o:OrderRow={id,order_number:orderNumber,order_type:orderType==='delivery'?'delivery':'dine_in',status:'Pendiente',created_at:new Date().toISOString(),business_date:today,subtotal:subtotal,deliveryFee:deliveryFee,total:total,paymentMethod:null,amountPaid:0,tip:0,change:0,cashInBox:0,deliveryPayout:orderType==='delivery'?FIXED_DELIVERY_FEE:0,lines:billLines.map(l=>({itemId:l.id,name:l.name,quantity:l.quantity,freeQuantity:l.itako_promotion_code==='two_plus_one'?Math.floor(l.quantity/2):0,unitPrice:l.price,lineTotal:lineTotal(l),servedQuantity:l.quantity+(l.itako_promotion_code==='two_plus_one'?Math.floor(l.quantity/2):0)}))};
      setLoading(false);
      setChargeTarget(o);
      setChargeTotal(total);
    }catch(e:any){setError(friendlyError(e));setLoading(false)}
  };

  const viewOrder=(o:OrderRow)=>setTicket(o);

  const [chargeTarget,setChargeTarget]=useState<OrderRow|null>(null);
  const [chargeTotal,setChargeTotal]=useState(0);
  const [ticket,setTicket]=useState<OrderRow|null>(null);

  const finishCharge=async(detail:{cash:number;tip:number;change:number;method:string})=>{
    if(!chargeTarget)return;
    setLoading(true);setError('');
    try{
      await chargeOrder({orderId:chargeTarget.id,paymentMethodCode:detail.method,amountPaidCents:cents(detail.cash),tipAmountCents:cents(detail.tip),changeGivenCents:cents(detail.change)});
      const paidOrder: OrderRow = {
        ...chargeTarget,
        status:'Cobrado',
        paymentMethod:detail.method,
        amountPaid:detail.cash,
        tip:detail.tip,
        change:detail.change,
        cashInBox:detail.method===PAYMENT_CASH?Math.max(0,chargeTarget.subtotal):0,
        deliveryPayout:chargeTarget.order_type==='delivery'?FIXED_DELIVERY_FEE:0,
      };
      setChargeTarget(null);setCart([]);setEditingOrderId(null);setOrderType('local');setTicket(paidOrder);refresh();setPage('pedidos');
    }catch(e:any){setError(friendlyError(e));}
    finally{setLoading(false)}
  };

  const totals=useMemo(()=>{
    const paid=orders.filter(o=>o.status==='Cobrado');
    const sales=paid.reduce((s,o)=>s+o.subtotal,0);
    const delivery=paid.reduce((s,o)=>s+o.deliveryPayout,0);
    const cashSales=paid.filter(o=>o.paymentMethod===PAYMENT_CASH).reduce((s,o)=>s+o.cashInBox,0);
    const transferSales=paid.filter(o=>o.paymentMethod===PAYMENT_TRANSFER).reduce((s,o)=>s+o.total,0);
    const expenseTotal=expenses.filter(e=>e.business_date===today).reduce((s,e)=>s+e.amount,0);
    const payroll=workDays.filter(w=>w.work_date===today).reduce((s,w)=>s+Number(w.pay_cents||0)/100,0);
    // cashInBox is the business portion actually retained in the caja.
    // Delivery fees and tips are kept outside this business cash balance.
    const cashOnHand=(cashDay?.opening_float_cents||0)/100+cashSales-expenseTotal-delivery-payroll;
    const next=(cashDay?.next_day_float_cents||0)/100;
    const net=sales-expenseTotal-delivery-payroll-next;
    return{sales,delivery,cashSales,transferSales,expenseTotal,payroll,cashOnHand,next,net,orders:orders.length};
  },[orders,expenses,workDays,cashDay,today]);

  const title = ({inicio:'Inicio',orden:'Nueva orden',pedidos:'Pedidos de hoy',caja:'Caja',menu:'Menú',gastos:'Gastos',inventario:'Inventario',empleados:'Empleados',ganancias:'Ganancias del mes'} as Record<Page,string>)[page];
  const subtitle = ({inicio:'Todo inicia en cero y se actualiza conforme haces movimientos.',orden:'Registra la venta, guarda pedidos pendientes y cobra cuando corresponda.',pedidos:'Consulta cada pedido del día y el conteo real de productos vendidos.',caja:'Fondo de cambio, efectivo disponible y corte del día.',menu:'Productos y precios del menú de la taquería.',gastos:'Registra y consulta los gastos del negocio.',inventario:'Existencias, movimientos y costo de compra.',empleados:'Registro sencillo y pago por día.',ganancias:'Calendario diario con ventas, gastos, repartidores, empleados y lo que quedó.'} as Record<Page,string>)[page];

  if(authLoading || loading && !items.length && !error) return <div className="min-h-screen grid place-items-center bg-slate-50 text-slate-600">Cargando Itako…</div>;
  if(!locationId) return <div className="min-h-screen grid place-items-center bg-slate-50 p-6"><div className="max-w-md rounded-2xl border bg-white p-8 text-center shadow-sm"><h1 className="mb-2 text-2xl font-bold text-slate-900">Itako</h1><p className="text-slate-600">No se encontró el local de Itako. Ejecuta la migración de la taquería y vuelve a iniciar sesión.</p></div></div>;

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <style>{`@media(max-width:900px){.itako-stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}.itako-grid3{grid-template-columns:1fr!important}.itako-order{grid-template-columns:1fr!important}.itako-cart{position:static!important}.itako-product{grid-template-columns:repeat(2,minmax(0,1fr))!important}}@media(max-width:560px){.itako-stats,.itako-product{grid-template-columns:1fr!important}.itako-main{padding:16px!important}.itako-modal{padding:16px!important;width:calc(100vw - 20px)!important;max-height:94vh!important}.itako-calendar{grid-template-columns:repeat(2,minmax(0,1fr))!important}}`}</style>
    <header className="sticky top-0 z-30 flex h-[72px] items-center border-b border-slate-200 bg-white px-5">
      <button onClick={()=>setMenuOpen(v=>!v)} className="flex items-center gap-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-200" aria-label="Abrir menú de Itako"><span className="grid h-11 w-11 place-items-center rounded-[14px] bg-red-600 text-xl font-extrabold text-white">I</span><span className="text-[23px] font-extrabold tracking-tight">Itako</span></button>
    </header>
    <aside className={`fixed left-0 top-[72px] z-20 h-[calc(100vh-72px)] w-[260px] border-r border-slate-200 bg-white p-3 shadow-xl transition-transform ${menuOpen?'translate-x-0':'-translate-x-[105%]'}`}>
      <div className="mb-3 px-2 pt-2 text-xs font-bold uppercase tracking-[1px] text-slate-400">Menú del sistema</div>
      {[['inicio','Inicio'],['orden','Nueva orden'],['pedidos','Pedidos de hoy'],['caja','Caja'],['menu','Menú'],['gastos','Gastos'],['inventario','Inventario'],['empleados','Empleados'],['ganancias','Ganancias del mes']].map(([p,l])=><button key={p} onClick={()=>{setPage(p as Page);setMenuOpen(false)}} className={`mb-1 w-full rounded-xl px-3 py-3 text-left font-bold ${page===p?'bg-red-50 text-red-600':'text-slate-700 hover:bg-slate-50'}`}>{l}</button>)}
    </aside>
    <main className="itako-main mx-auto max-w-[1600px] p-7">
      <div className="mb-5"><h1 className="text-[29px] font-extrabold tracking-tight text-slate-900">{title}</h1><p className="mt-1 text-slate-500">{subtitle}</p></div>
      <ErrBox message={error}/>
      {page==='inicio'&&<Inicio onGo={p=>setPage(p)} orders={orders} totals={totals} view={viewOrder}/>} 
      {page==='orden'&&<Orden items={items} category={category} setCategory={setCategory} cart={cart} addItem={addItem} changeItem={changeItem} billLines={billLines} subtotal={subtotal} deliveryFee={deliveryFee} total={total} orderType={orderType} setOrderType={setOrderType} onClear={()=>setCart([])} onSave={()=>void saveOrder(false)} onCharge={()=>void openCharge()} editingOrderId={editingOrderId} packages={packages} components={components}/>} 
      {page==='pedidos'&&<Pedidos orders={orders} view={viewOrder} edit={startEditingOrder} onRefresh={refresh} consumptions={consumptions} employees={employees} items={items} locationId={locationId} date={today}/>} 
      {page==='caja'&&<Caja cashDay={cashDay} setCashDay={setCashDay} totals={totals} employees={employees} workDays={workDays} setWorkDays={setWorkDays} locationId={locationId} date={today} exportData={()=>exportExcel({date:today,orders,expenses,employees,workDays,inventory,consumptions,totals,cashDay})}/>} 
      {page==='menu'&&<MenuPage items={items} setItems={setItems} packages={packages} setPackages={setPackages} locationId={locationId} categories={categories}/>} 
      {page==='gastos'&&<Gastos expenses={expenses} setExpenses={setExpenses} locationId={locationId} date={today}/>} 
      {page==='inventario'&&<Inventario inventory={inventory} setInventory={setInventory} locationId={locationId}/>} 
      {page==='empleados'&&<Empleados employees={employees} setEmployees={setEmployees} workDays={workDays} setWorkDays={setWorkDays} locationId={locationId} date={today}/>} 
      {page==='ganancias'&&<Ganancias locationId={locationId} month={today.slice(0,7)} nextFloatToday={(cashDay?.next_day_float_cents||0)/100}/>} 
    </main>
    {chargeTarget&&<ChargeModal total={chargeTotal} orderId={chargeTarget.id} orderType={chargeTarget.order_type} subtotal={chargeTarget.subtotal} onClose={()=>setChargeTarget(null)} onDone={()=>{}} finishCharge={finishCharge}/>} 
    {ticket&&<TicketModal order={ticket} onClose={()=>setTicket(null)} onNewOrder={()=>{setTicket(null);setPage('orden')}} />} 
  </div>;
}

function Inicio({onGo,orders,totals,view}:{onGo:(p:Page)=>void;orders:OrderRow[];totals:any;view:(o:OrderRow)=>void}){
 const actions:[string,string,string,Page][]=[['🧾','Nueva orden','Registrar una venta','orden'],['💵','Caja','Fondo y corte del día','caja'],['🌮','Menú','Productos y precios','menu'],['💳','Gastos','Registrar gastos','gastos'],['📦','Inventario','Entradas, salidas y merma','inventario'],['👥','Empleados','Personal y pago diario','empleados']];
 return <>
  <div className="itako-stats grid grid-cols-4 gap-4">{[['Total vendido',totals.sales],['Gastos',totals.expenseTotal],['Repartidores',totals.delivery],['Neto disponible',totals.net]].map(([l,v])=><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" key={l as string}><div className="text-sm text-slate-500">{l}</div><div className="mt-2 text-[30px] font-extrabold">{money(Number(v))}</div></div>)}</div>
  <div className="itako-grid3 mt-5 grid grid-cols-3 gap-4">{actions.map(a=><button key={a[3]} onClick={()=>onGo(a[3])} className="min-h-[150px] rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="text-3xl">{a[0]}</div><div className="mt-6 text-[22px] font-extrabold text-black">{a[1]}</div><div className="mt-1 text-slate-500">{a[2]}</div></button>)}</div>
  <div className="mb-3 mt-7 flex items-center justify-between"><h2 className="text-[21px] font-extrabold">Pedidos de hoy</h2><button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold" onClick={()=>onGo('pedidos')}>Ver pedidos</button></div>
  <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">{orders.length?<OrderTable orders={orders.slice(0,5)} view={view} edit={()=>{}}/>:<div className="p-10 text-center text-slate-500">No hay pedidos. Total de órdenes: 0.</div>}</div>
 </>;
}

function OrderTable({orders,view,edit,onCancel}:{orders:OrderRow[];view:(o:OrderRow)=>void;edit:(o:OrderRow)=>void;onCancel?:(o:OrderRow)=>void}){
 return <table className="w-full min-w-[850px] border-collapse"><thead className="bg-slate-50"><tr>{['Orden','Hora','Pedido detallado','Tipo','Total','Estado',''].map(x=><th key={x} className="border-b border-slate-200 px-3 py-3 text-left text-xs font-bold uppercase text-slate-400">{x}</th>)}</tr></thead><tbody>{orders.map(o=><tr key={o.id} className="border-b border-slate-100 last:border-0"><td className="px-3 py-3 font-bold">#{o.order_number||o.id.slice(0,6)}</td><td className="px-3 py-3 text-sm">{new Date(o.created_at).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}</td><td className="px-3 py-3 text-sm">{o.lines.map((l,i)=><div key={i}>{l.quantity} × {l.name} — {money(l.lineTotal)}{l.freeQuantity?<span className="ml-1 text-xs text-slate-500">(entregar {l.servedQuantity})</span>:null}</div>)}</td><td className="px-3 py-3">{mapType(o.order_type)}</td><td className="px-3 py-3 font-bold">{money(o.total)}</td><td className="px-3 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${o.status==='Cobrado'?'bg-green-100 text-green-700':'bg-amber-100 text-amber-700'}`}>{o.status}</span></td><td className="px-3 py-3"><div className="flex gap-2">{o.status==='Pendiente'?<><button className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white" onClick={()=>edit(o)}>Editar/Cobrar</button>{onCancel?<button className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700" onClick={()=>onCancel(o)}>Cancelar</button>:null}</>:null}<button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold" onClick={()=>view(o)}>Ver</button></div></td></tr>)}</tbody></table>
}

function Orden({items,category,setCategory,cart,addItem,changeItem,billLines,subtotal,deliveryFee,total,orderType,setOrderType,onClear,onSave,onCharge,editingOrderId,packages}:{items:ItemRow[];category:MenuCategory;setCategory:(c:MenuCategory)=>void;cart:CartLine[];addItem:(x:ItemRow)=>void;changeItem:(id:string,d:number)=>void;billLines:CartLine[];subtotal:number;deliveryFee:number;total:number;orderType:'local'|'delivery';setOrderType:(x:'local'|'delivery')=>void;onClear:()=>void;onSave:()=>void;onCharge:()=>void;editingOrderId:string|null;packages:PackageRow[];components:PackageComponent[]}){
 const cats:MenuCategory[]=['Tacos','Gringas','Quesadillas','Por kilo','Bebidas'];
 const shown=items.filter(i=>i.categoryName===category);
 return <div className="itako-order grid grid-cols-[1.2fr_.8fr] gap-5">
  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-4 flex flex-wrap gap-2">{cats.map(c=><button key={c} className={`rounded-full border px-4 py-2 text-sm font-bold ${category===c?'border-red-200 bg-red-50 text-red-600':'border-slate-200 bg-white text-slate-600'}`} onClick={()=>setCategory(c)}>{c}</button>)}</div>
   <div className="itako-product grid grid-cols-3 gap-4">{shown.map(p=><div className="rounded-2xl border border-slate-200 p-4" key={p.id}><div className="mb-2 inline-flex rounded-full bg-slate-100 px-2 py-1 text-[11px] font-extrabold text-slate-500">{catLabel(p.categoryName)}</div>{p.itako_promotion_code==='two_plus_one'&&<span className="ml-1 inline-flex rounded-full bg-amber-50 px-2 py-1 text-[11px] font-extrabold text-amber-700">3x2</span>}{p.categoryName==='Gringas'&&<span className="ml-1 inline-flex rounded-full bg-amber-50 px-2 py-1 text-[11px] font-extrabold text-amber-700">2 por {p.name.toLowerCase().includes('asada')?'$60':'$50'}</span>}<div className="mt-2 font-extrabold">{p.name}</div><div className="my-2 text-xl font-extrabold">{money(p.price)}</div>{p.itako_promotion_code==='two_plus_one'?<div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs font-bold text-amber-800">Cada 2 tacos pagados agrega 1 gratis. Ejemplo: 5 pagados → entregar 7.</div>:p.categoryName==='Gringas'?<div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs font-bold text-amber-800">2 por {p.name.toLowerCase().includes('asada')?'$60':'$50'}.</div>:null}<button className="w-full rounded-xl bg-red-600 px-3 py-2.5 text-sm font-bold text-white" onClick={()=>addItem(p)}>Agregar</button></div>)}</div>
   <div className="mt-8 mb-3 flex items-center justify-between"><h2 className="text-xl font-extrabold">Paquetes</h2><span className="text-xs text-slate-500">Si pides el conjunto completo, se cobra como paquete.</span></div>
   <div className="grid grid-cols-3 gap-4">{packages.map(p=><div key={p.id} className="rounded-2xl border border-slate-200 p-4"><div className="font-extrabold">{p.name}</div><div className="my-2 text-xs text-slate-500">{p.description}</div><div className="text-xl font-extrabold">{money(Number(p.package_price_cents)/100)}</div><button className="mt-3 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" onClick={()=>{}}>Se aplica al combinar</button></div>)}</div>
  </div>
  <div className="itako-cart sticky top-[92px] h-max rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-extrabold">{editingOrderId?'Editar orden':'Orden actual'}</h2>{cart.length?<button onClick={onClear} className="rounded-lg bg-red-50 px-2 py-1 text-xs font-bold text-red-700">Vaciar</button>:null}</div>
   <div className="mb-3 grid grid-cols-2 gap-2"><button onClick={()=>setOrderType('local')} className={`rounded-xl px-3 py-2 text-sm font-bold ${orderType==='local'?'bg-red-600 text-white':'bg-slate-100 text-slate-700'}`}>En el local</button><button onClick={()=>setOrderType('delivery')} className={`rounded-xl px-3 py-2 text-sm font-bold ${orderType==='delivery'?'bg-red-600 text-white':'bg-slate-100 text-slate-700'}`}>Entrega</button></div>
   <div className="mb-3 text-xs text-slate-500">{orderType==='delivery'?'Se suman $10 al cliente y los $10 se separan para entregarlos al repartidor.':'Sin cobro de entrega.'}</div>
   {billLines.length?billLines.map((l,i)=>{const free=l.itako_promotion_code==='two_plus_one'?Math.floor(l.quantity/2):0;return <div key={i} className="border-b border-slate-100 py-3"><div className="flex justify-between gap-3"><div><div className="font-bold">{l.quantity} × {l.name}</div><div className="text-xs text-slate-500">{money(l.price)} c/u{l.categoryName==='Gringas'?' · promo 2 por '+(l.name.toLowerCase().includes('asada')?'$60':'$50'):''}</div></div><div className="font-bold">{money(lineTotal(l))}</div></div>{l.itako_promotion_code==='two_plus_one'?<div className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-xs font-bold text-amber-800">Se cobran {l.quantity} y se entregan {l.quantity+free}. Gratis: {free}.</div>:null}</div>}) : <div className="p-8 text-center text-slate-500">No hay productos todavía.</div>}
   <div className="mt-3 border-t border-slate-200 pt-3"><div className="flex justify-between py-1"><span>Venta de productos</span><strong>{money(subtotal)}</strong></div>{deliveryFee?<div className="flex justify-between py-1"><span>Entrega / pago al repartidor</span><strong>{money(deliveryFee)}</strong></div>:null}<div className="mt-2 flex justify-between text-[23px] font-extrabold"><span>Total a cobrar</span><strong>{money(total)}</strong></div><div className="mt-3 flex flex-wrap justify-end gap-2"><button disabled={!billLines.length} onClick={onSave} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold disabled:opacity-40">Guardar orden</button><button disabled={!billLines.length} onClick={onCharge} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">Cobrar pedido</button></div></div>
  </div>
 </div>
}

function Pedidos({orders,view,edit,onRefresh,consumptions,employees,items,locationId,date}:{orders:OrderRow[];view:(o:OrderRow)=>void;edit:(o:OrderRow)=>void;onRefresh:()=>void;consumptions:StaffConsumption[];employees:Employee[];items:ItemRow[];locationId:string;date:string}){
 const [showConsumption,setShowConsumption]=useState(false); const [employeeId,setEmployeeId]=useState(''); const [itemId,setItemId]=useState(''); const [qty,setQty]=useState('1');
 const sold=new Map<string,number>(); orders.filter(o=>o.status==='Cobrado').forEach(o=>o.lines.forEach(l=>sold.set(l.name,(sold.get(l.name)||0)+l.servedQuantity)));
 const saveConsumption=async()=>{if(!locationId||!qty||!itemId||!employeeId)return;const it=items.find(x=>x.id===itemId);if(!it)return;const r=await supabase.from('itako_staff_consumptions').insert({location_id:locationId,work_date:date,employee_id:employeeId||null,item_id:it.id,product_name_snapshot:it.name,quantity:Number(qty),unit_price_cents:cents(it.price)});if(r.error)return alert(friendlyError(r.error));setShowConsumption(false);onRefresh()};
 const cancelPending=async(o:OrderRow)=>{if(!confirm('¿Cancelar esta orden pendiente?'))return;const r=await supabase.from('orders').update({status:'cancelled'}).eq('id',o.id);if(r.error)return alert(friendlyError(r.error));onRefresh()};
 return <>
  <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm"><OrderTable orders={orders} view={view} edit={edit} onCancel={cancelPending}/></div>
  <div className="my-5 flex items-center justify-between"><h2 className="text-[21px] font-extrabold">Conteo de productos vendidos</h2><span className="text-xs text-slate-500">Solo pedidos cobrados. El consumo del personal va aparte.</span></div>
  <div className="itako-grid3 grid grid-cols-3 gap-4">{sold.size?Array.from(sold.entries()).map(([n,q])=><div key={n} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">{n}</div><div className="mt-1 text-3xl font-extrabold">{q}</div><div className="text-xs text-slate-500">unidades</div></div>):<div className="col-span-full rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">Todo en 0 hasta que se registre una venta.</div>}</div>
  <div className="my-5 flex items-center justify-between"><h2 className="text-[21px] font-extrabold">Consumo del personal</h2><button onClick={()=>setShowConsumption(v=>!v)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold">Registrar consumo</button></div>
  {showConsumption&&<div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5"><div className="grid gap-3 md:grid-cols-4"><select className="rounded-xl border border-slate-200 p-2" value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">Empleado</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select><select className="rounded-xl border border-slate-200 p-2" value={itemId} onChange={e=>setItemId(e.target.value)}><option value="">Producto</option>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select><input className="rounded-xl border border-slate-200 p-2" type="number" min="1" step="1" value={qty} onChange={e=>setQty(e.target.value)}/><button onClick={saveConsumption} className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white">Guardar</button></div></div>}
  <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">{consumptions.length?<table className="w-full"><thead><tr><th className="px-3 py-3 text-left text-xs text-slate-400">Persona</th><th className="px-3 py-3 text-left text-xs text-slate-400">Producto</th><th className="px-3 py-3 text-left text-xs text-slate-400">Cantidad</th></tr></thead><tbody>{consumptions.map(c=><tr key={c.id} className="border-t border-slate-100"><td className="px-3 py-3">{employees.find(e=>e.id===c.employee_id)?.name||'Personal'}</td><td className="px-3 py-3">{c.product_name_snapshot}</td><td className="px-3 py-3">{c.quantity}</td></tr>)}</tbody></table>:<div className="p-8 text-center text-slate-500">No hay consumos del personal registrados.</div>}</div>
 </>
}

function ChargeModal({total,orderId,orderType,subtotal,onClose,finishCharge}:{total:number;orderId:string;orderType:string;subtotal:number;onClose:()=>void;onDone:()=>void;finishCharge:(d:{cash:number;tip:number;change:number;method:string})=>Promise<void>}){
 const [method,setMethod]=useState(PAYMENT_CASH); const [input,setInput]=useState('0'); const [tip,setTip]=useState(false); const given=Number(input||0); const change=tip?0:Math.max(0,given-total); const tipAmount=tip?Math.max(0,given-total):0;
 const press=(v:string)=>setInput(v==='Borrar'?'0':input==='0'?v:`${input}${v}`); const quick=(v:number)=>setInput(v.toFixed(2));
 const can=method===PAYMENT_TRANSFER||given>=total;
 return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/55 p-3" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="itako-modal relative w-[610px] max-w-full overflow-auto rounded-[22px] bg-white p-6 shadow-2xl"><button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-1 text-slate-500 hover:bg-slate-100" aria-label="Cerrar"><X/></button><h3 className="text-[25px] font-extrabold">Cobrar pedido</h3><div className="mt-1 text-sm text-slate-500">Por cobrar</div><div className="text-right text-[37px] font-extrabold">{money(total)}</div><div className="mt-4 flex gap-2"><button className={`rounded-full border px-4 py-2 font-bold ${method===PAYMENT_CASH?'border-red-200 bg-red-50 text-red-600':'border-slate-200'}`} onClick={()=>setMethod(PAYMENT_CASH)}>Efectivo</button><button className={`rounded-full border px-4 py-2 font-bold ${method===PAYMENT_TRANSFER?'border-red-200 bg-red-50 text-red-600':'border-slate-200'}`} onClick={()=>setMethod(PAYMENT_TRANSFER)}>Transferencia</button></div>{method===PAYMENT_CASH?<>
   <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="text-sm text-slate-500">Cliente entregó</div><input aria-label="Dinero entregado por el cliente" className="mt-1 w-full bg-transparent text-right text-[34px] font-extrabold text-slate-900 outline-none" type="number" min="0" step=".01" inputMode="decimal" value={input} onChange={e=>setInput(e.target.value)} /><div className="mt-2 text-sm text-slate-500">Cambio a entregar</div><div className="text-right text-[28px] font-extrabold text-green-700">{money(change)}</div></div>
   <div className="mt-3 grid grid-cols-4 gap-2">{[50,100,200,500].map(x=><button key={x} className="rounded-xl border border-slate-200 bg-white p-2.5 font-extrabold" onClick={()=>quick(x)}>{money(x)}</button>)}</div>
   <div className="mt-2 grid grid-cols-3 gap-2">{['1','2','3','4','5','6','7','8','9','Borrar','0','00'].map(k=><button key={k} className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 font-extrabold" onClick={()=>press(k)}>{k}</button>)}</div>
   <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={tip} onChange={e=>setTip(e.target.checked)}/> El cliente deja el cambio como propina para el chico</label>
   {orderType==='delivery'&&<div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">Del total, {money(subtotal)} corresponde a la venta. Los {money(10)} se separan para pagar al repartidor.</div>}
  </>:<div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">La transferencia se registra por {money(total)}. No entra efectivo ni hay cambio.</div>}
  {!can&&<div className="mt-3 text-sm font-bold text-red-600">El dinero entregado no alcanza para cubrir el total.</div>}
  <div className="mt-5 flex justify-end gap-2"><button className="rounded-xl border border-slate-200 px-4 py-2.5 font-bold" onClick={onClose}>Cancelar</button><button disabled={!can} className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white disabled:opacity-40" onClick={()=>void finishCharge({cash:method===PAYMENT_TRANSFER?total:given,tip:method===PAYMENT_CASH?tipAmount:0,change:method===PAYMENT_CASH?change:0,method})}>Cobrar y ver ticket</button></div>
 </div></div>
}

function TicketModal({order,onClose,onNewOrder}:{order:OrderRow;onClose:()=>void;onNewOrder:()=>void}){
 const cashBusiness=order.paymentMethod===PAYMENT_CASH?order.subtotal:0;
 return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/55 p-3" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="itako-modal relative w-[650px] max-w-full overflow-auto rounded-[22px] bg-white p-6 shadow-2xl"><button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-1 text-slate-500 hover:bg-slate-100"><X/></button><h3 className="text-[25px] font-extrabold">{order.status==='Cobrado'?'Venta cobrada':'Detalle de la orden'}</h3><div className="mt-1 inline-flex rounded-full bg-green-100 px-3 py-1 text-xs font-extrabold text-green-700">Orden #{order.order_number||order.id.slice(0,6)} · {mapType(order.order_type)}</div><div className="mt-4 overflow-auto"><table className="w-full min-w-[520px]"><thead><tr className="bg-slate-50"><th className="px-3 py-3 text-left text-xs text-slate-400">Producto</th><th className="px-3 py-3 text-left text-xs text-slate-400">Cant.</th><th className="px-3 py-3 text-left text-xs text-slate-400">Precio c/u</th><th className="px-3 py-3 text-right text-xs text-slate-400">Importe</th></tr></thead><tbody>{order.lines.map((l,i)=><tr key={i} className="border-b border-slate-100"><td className="px-3 py-3 font-bold">{l.name}{l.freeQuantity?<div className="text-xs text-slate-500">Entregar {l.servedQuantity} ({l.freeQuantity} gratis)</div>:null}</td><td className="px-3 py-3">{l.quantity}</td><td className="px-3 py-3">{money(l.unitPrice)}</td><td className="px-3 py-3 text-right font-bold">{money(l.lineTotal)}</td></tr>)}</tbody></table></div>{order.deliveryFee?<div className="mt-3 flex justify-between"><span>Entrega / pago al repartidor</span><strong>{money(order.deliveryFee)}</strong></div>:null}<div className="mt-2 flex justify-between text-[25px] font-extrabold"><span>Total</span><strong>{money(order.total)}</strong></div>{order.status==='Cobrado'?(order.paymentMethod===PAYMENT_TRANSFER?<div className="mt-1 flex justify-between"><span>Transferencia recibida</span><strong>{money(order.amountPaid)}</strong></div>:<><div className="mt-1 flex justify-between"><span>Cliente entregó</span><strong>{money(order.amountPaid)}</strong></div><div className="mt-1 flex justify-between"><span>Cambio entregado</span><strong>{money(order.change)}</strong></div><div className="mt-1 flex justify-between"><span>Efectivo en caja</span><strong>{money(cashBusiness)}</strong></div></>):<div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Esta orden está pendiente. Todavía no se ha registrado el cobro.</div>}{order.deliveryFee?<div className="mt-1 flex justify-between"><span>Pago al repartidor</span><strong>{money(FIXED_DELIVERY_FEE)}</strong></div>:null}{order.tip?<div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Propina para el chico: {money(order.tip)}. No cuenta como venta ni como efectivo del negocio.</div>:null}<div className="mt-5 flex justify-end"><button onClick={order.status==='Cobrado'?onNewOrder:onClose} className="rounded-xl bg-red-600 px-5 py-2.5 font-bold text-white">{order.status==='Cobrado'?'Nueva orden':'Cerrar'}</button></div></div></div>
}

function Caja({cashDay,setCashDay,totals,employees,workDays,setWorkDays,locationId,date,exportData}:{cashDay:CashDay|null;setCashDay:(v:CashDay)=>void;totals:any;employees:Employee[];workDays:WorkDay[];setWorkDays:(v:WorkDay[])=>void;locationId:string;date:string;exportData:()=>void}){
 const [open,setOpen]=useState(String(((cashDay?.opening_float_cents||0)/100)));const [next,setNext]=useState(String(((cashDay?.next_day_float_cents||0)/100)));
 useEffect(()=>{setOpen(String(((cashDay?.opening_float_cents||0)/100)));setNext(String(((cashDay?.next_day_float_cents||0)/100)))},[cashDay]);
 const save=async(field:'opening_float_cents'|'next_day_float_cents',value:string)=>{if(!cashDay)return;const val=cents(Number(value||0));const r=await supabase.from('itako_cash_days').update({[field]:val}).eq('id',cashDay.id).select().single();if(r.error)return alert(friendlyError(r.error));setCashDay(r.data as CashDay)};
 const togg=async(id:string,checked:boolean)=>{const e=employees.find(x=>x.id===id);if(!e||!cashDay)return; if(checked){const exists=workDays.find(w=>w.employee_id===id&&w.work_date===date);if(!exists){const r=await supabase.from('itako_employee_work_days').insert({location_id:locationId,employee_id:id,work_date:date,pay_cents:Number(e.daily_pay_cents||0)});if(r.error)return alert(friendlyError(r.error))}}else{await supabase.from('itako_employee_work_days').delete().eq('location_id',locationId).eq('employee_id',id).eq('work_date',date)}; const r=await supabase.from('itako_employee_work_days').select('*').eq('location_id',locationId);if(!r.error)setWorkDays((r.data||[]) as WorkDay[])};
 return <><div className="itako-grid3 grid grid-cols-3 gap-4"><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">Fondo de caja inicial</div><div className="mt-1 text-3xl font-extrabold">{money(Number(open))}</div><div className="mt-3 flex gap-2"><input className="w-28 rounded-xl border border-slate-200 p-2" type="number" min="0" step=".01" value={open} onChange={e=>setOpen(e.target.value)}/><button className="rounded-xl bg-red-600 px-3 py-2 text-sm font-bold text-white" onClick={()=>void save('opening_float_cents',open)}>Guardar</button></div></div><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">Efectivo disponible en caja</div><div className="mt-1 text-3xl font-extrabold">{money(totals.cashOnHand)}</div><div className="mt-2 text-xs text-slate-500">Fondo inicial + ventas en efectivo − gastos − repartidores − empleados.</div></div><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">Fondo para mañana</div><div className="mt-1 text-3xl font-extrabold">{money(Number(next))}</div><div className="mt-3 flex gap-2"><input className="w-28 rounded-xl border border-slate-200 p-2" type="number" min="0" step=".01" value={next} onChange={e=>setNext(e.target.value)}/><button className="rounded-xl bg-red-600 px-3 py-2 text-sm font-bold text-white" onClick={()=>void save('next_day_float_cents',next)}>Guardar</button></div></div></div>
 <div className="my-5 flex items-center justify-between"><h2 className="text-[21px] font-extrabold">Corte del día</h2><button onClick={exportData} className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white"><Download className="h-4 w-4"/> Descargar Excel</button></div>
 <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex justify-between py-2"><span>Ventas</span><strong>{money(totals.sales)}</strong></div><div className="flex justify-between py-2"><span>Gastos</span><strong>− {money(totals.expenseTotal)}</strong></div><div className="flex justify-between py-2"><span>Repartidores</span><strong>− {money(totals.delivery)}</strong></div><div className="flex justify-between py-2"><span>Empleados</span><strong>− {money(totals.payroll)}</strong></div><div className="flex justify-between py-2"><span>Fondo para mañana</span><strong>− {money(Number(next))}</strong></div><div className="mt-2 flex justify-between border-t border-slate-200 pt-3 text-[25px] font-extrabold"><span>Neto disponible</span><strong>{money(totals.sales-totals.expenseTotal-totals.delivery-totals.payroll-Number(next))}</strong></div><div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">El fondo inicial es dinero de cambio, no ganancia. En una entrega de $140 + $10, los $140 son venta y los $10 se separan para el repartidor.</div></div>
 <div className="my-5"><h2 className="mb-3 text-[21px] font-extrabold">Empleados que trabajaron hoy</h2><div className="rounded-2xl border border-slate-200 bg-white shadow-sm">{employees.length?employees.map(e=><label key={e.id} className="flex items-center justify-between border-b border-slate-100 px-4 py-3 last:border-0"><span><input className="mr-2" type="checkbox" checked={!!workDays.find(w=>w.employee_id===e.id&&w.work_date===date)} onChange={ev=>void togg(e.id,ev.target.checked)}/><strong>{e.name}</strong></span><span className="text-sm text-slate-500">{money(Number(e.daily_pay_cents||0)/100)}</span></label>):<div className="p-8 text-center text-slate-500">No hay empleados registrados.</div>}</div></div>
 </>;
}

function MenuPage({items,setItems,packages,setPackages,locationId,categories}:{items:ItemRow[];setItems:(x:ItemRow[])=>void;packages:PackageRow[];setPackages:(x:PackageRow[])=>void;locationId:string;categories:CategoryRow[]}):ReactNode{
 const fallback:CategoryRow[]=[{id:'',name:'Tacos',sort_order:10},{id:'',name:'Gringas',sort_order:20},{id:'',name:'Quesadillas',sort_order:30},{id:'',name:'Por kilo',sort_order:40},{id:'',name:'Bebidas',sort_order:50}];
 const catRows=categories.length?categories:fallback; const [name,setName]=useState(''); const [price,setPrice]=useState(''); const [catId,setCatId]=useState(categories[0]?.id||'');
 useEffect(()=>{if(!catId && categories[0]?.id)setCatId(categories[0].id)},[categories,catId]);
 const selectedCategory=catRows.find(c=>c.id===catId)||catRows[0];
 const add=async()=>{if(!name.trim()||!price||!catId)return;const r=await supabase.from('items').insert({location_id:locationId,category_id:catId,name:name.trim(),price:Number(price),is_active:true,sort_order:100,recipe_type:'simple',recipe_complexity:'simple'}).select('id,name,price,category_id,itako_promotion_code').single();if(r.error)return alert(friendlyError(r.error));const created=r.data as any;setItems([...items,{id:created.id,name:created.name,price:Number(created.price),category_id:created.category_id,categoryName:String(selectedCategory.name),itako_promotion_code:null}]);setName('');setPrice('')};
 const edit=async(i:number)=>{const p=items[i];const n=prompt('Nombre',p.name);if(n==null)return;const v=Number(prompt('Precio',String(p.price)));if(!Number.isFinite(v)||v<0)return;const r=await supabase.from('items').update({name:n.trim(),price:v}).eq('id',p.id);if(r.error)return alert(friendlyError(r.error));const copy=[...items];copy[i]={...p,name:n.trim(),price:v};setItems(copy)};
 const remove=async(i:number)=>{if(!confirm('¿Eliminar este producto del menú?'))return;const p=items[i];const r=await supabase.from('items').update({is_active:false}).eq('id',p.id);if(r.error)return alert(friendlyError(r.error));setItems(items.filter((_,ix)=>ix!==i))};
 const editPkg=async(p:PackageRow)=>{const v=Number(prompt('Precio del paquete',String(Number(p.package_price_cents)/100)));if(!Number.isFinite(v)||v<0)return;const r=await supabase.from('itako_packages').update({package_price_cents:cents(v)}).eq('id',p.id);if(r.error)return alert(friendlyError(r.error));const ir=await supabase.from('items').update({price:v}).eq('id',p.package_item_id);if(ir.error)return alert(friendlyError(ir.error));setPackages(packages.map(x=>x.id===p.id?{...x,package_price_cents:cents(v)}:x))};
 return <><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="grid gap-3 md:grid-cols-4"><input className="rounded-xl border border-slate-200 p-2.5" placeholder="Nombre" value={name} onChange={e=>setName(e.target.value)}/><input className="rounded-xl border border-slate-200 p-2.5" type="number" step=".01" placeholder="Precio" value={price} onChange={e=>setPrice(e.target.value)}/><select className="rounded-xl border border-slate-200 p-2.5" value={catId} onChange={e=>setCatId(e.target.value)}>{catRows.map(c=><option key={c.id||c.name} value={c.id}>{c.name}</option>)}</select><button onClick={()=>void add()} disabled={!catId} className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white disabled:opacity-40">Agregar producto</button></div></div>
 <div className="my-5"><h2 className="text-[21px] font-extrabold">Productos</h2></div><div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[700px]"><thead><tr className="bg-slate-50">{['Producto','Categoría','Precio',''].map(h=><th key={h} className="px-3 py-3 text-left text-xs text-slate-400">{h}</th>)}</tr></thead><tbody>{items.map((p,i)=><tr key={p.id} className="border-t border-slate-100"><td className="px-3 py-3 font-bold">{p.name}</td><td className="px-3 py-3">{p.categoryName||'—'}</td><td className="px-3 py-3">{money(p.price)}</td><td className="px-3 py-3"><button onClick={()=>void edit(i)} className="mr-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">Editar</button><button onClick={()=>void remove(i)} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Eliminar</button></td></tr>)}</tbody></table></div>
 <div className="my-5"><h2 className="mb-3 text-[21px] font-extrabold">Paquetes</h2><div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[700px]"><thead><tr className="bg-slate-50"><th className="px-3 py-3 text-left text-xs text-slate-400">Paquete</th><th className="px-3 py-3 text-left text-xs text-slate-400">Contenido</th><th className="px-3 py-3 text-left text-xs text-slate-400">Precio</th><th></th></tr></thead><tbody>{packages.map(p=><tr key={p.id} className="border-t border-slate-100"><td className="px-3 py-3 font-bold">{p.name}</td><td className="px-3 py-3 text-sm">{p.description}</td><td className="px-3 py-3">{money(Number(p.package_price_cents)/100)}</td><td className="px-3 py-3"><button onClick={()=>void editPkg(p)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">Editar precio</button></td></tr>)}</tbody></table></div></div></>;
}

function Gastos({expenses,setExpenses,locationId,date}:{expenses:ExpenseRow[];setExpenses:(x:ExpenseRow[])=>void;locationId:string;date:string}){
 const [cat,setCat]=useState<string>('Renta');const [amt,setAmt]=useState('');
 const add=async()=>{if(!amt)return;const v=Number(amt);const r=await supabase.from('itako_expenses').insert({location_id:locationId,category:cat,description:cat,amount_cents:cents(v),payment_method_code:'cash',business_date:date});if(r.error)return alert(friendlyError(r.error));setExpenses([{id:(r.data as any)?.id,category:cat,description:cat,amount:v,payment_method_code:'cash',created_at:new Date().toISOString(),business_date:date},...expenses]);setAmt('')};
 const edit=async(i:number)=>{const v=Number(prompt('Monto',String(expenses[i].amount)));if(!Number.isFinite(v)||v<=0)return;const r=await supabase.from('itako_expenses').update({amount_cents:cents(v)}).eq('id',expenses[i].id);if(r.error)return alert(friendlyError(r.error));const c=[...expenses];c[i]={...c[i],amount:v};setExpenses(c)};
 const del=async(i:number)=>{if(!confirm('¿Eliminar este gasto?'))return;const r=await supabase.from('itako_expenses').delete().eq('id',expenses[i].id);if(r.error)return alert(friendlyError(r.error));setExpenses(expenses.filter((_,ix)=>ix!==i))};
 const total=expenses.filter(e=>e.business_date===date).reduce((s,e)=>s+e.amount,0);
 return <><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="grid gap-3 md:grid-cols-3"><select className="rounded-xl border border-slate-200 p-2.5" value={cat} onChange={e=>setCat(e.target.value)}>{EXPENSE_CATEGORIES.map(c=><option key={c}>{c}</option>)}</select><input className="rounded-xl border border-slate-200 p-2.5" type="number" step=".01" placeholder="Monto" value={amt} onChange={e=>setAmt(e.target.value)}/><button onClick={()=>void add()} className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white">Guardar gasto</button></div></div><div className="my-5 flex items-center justify-between"><h2 className="text-[21px] font-extrabold">Gastos registrados</h2><strong>Total del día: {money(total)}</strong></div><div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">{expenses.length?<table className="w-full"><thead><tr className="bg-slate-50"><th className="px-3 py-3 text-left text-xs text-slate-400">Fecha</th><th className="px-3 py-3 text-left text-xs text-slate-400">Categoría</th><th className="px-3 py-3 text-left text-xs text-slate-400">Monto</th><th></th></tr></thead><tbody>{expenses.map((e,i)=><tr key={e.id} className="border-t border-slate-100"><td className="px-3 py-3">{new Date(e.created_at).toLocaleDateString('es-MX')}</td><td className="px-3 py-3">{e.category}</td><td className="px-3 py-3 font-bold">{money(e.amount)}</td><td className="px-3 py-3"><button onClick={()=>void edit(i)} className="mr-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">Editar</button><button onClick={()=>void del(i)} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Eliminar</button></td></tr>)}</tbody></table>:<Empty>Sin gastos. Total del día: $0.00</Empty>}</div></>;
}

function Inventario({inventory,setInventory,locationId}:{inventory:InventoryRow[];setInventory:(x:InventoryRow[])=>void;locationId:string}){
 const [editing,setEditing]=useState<number|null>(null);
 const [showNew,setShowNew]=useState(false);
 const [name,setName]=useState('');
 const [unit,setUnit]=useState<string>(UNITS[0]);
 const [cost,setCost]=useState('');
 const [initial,setInitial]=useState('0');
 const movement=async(i:number,type:'compra'|'uso'|'merma')=>{const q=Number(prompt(type==='compra'?'¿Cuánto entró?':type==='uso'?'¿Cuánto salió?':'¿Cuánto se perdió?','1')||0);if(!q||q<=0)return;const x=inventory[i];const r=await supabase.rpc('itako_record_inventory_movement',{p_location_id:locationId,p_inventory_item_id:x.id,p_movement_type:type,p_quantity:q});if(r.error)return alert(friendlyError(r.error));const nextStock=Number((r.data as any)?.current_stock ?? x.current_stock+(type==='compra'?q:-q));const c=[...inventory];c[i]={...x,current_stock:nextStock};setInventory(c)};
 const addInventory=async()=>{const q=Number(initial||0), cst=cost===''?null:Number(cost);if(!name.trim()||q<0||cst!==null&&(!Number.isFinite(cst)||cst<0))return;const r=await supabase.from('inventory_items').insert({location_id:locationId,name:name.trim(),unit:unitToCode(unit),current_stock:q,minimum_stock:0,cost_per_unit:cst}).select('id,name,unit,current_stock,cost_per_unit').single();if(r.error)return alert(friendlyError(r.error));setInventory([...inventory,{id:r.data.id,name:r.data.name,unit:r.data.unit,current_stock:Number(r.data.current_stock||0),cost_per_unit:r.data.cost_per_unit==null?null:Number(r.data.cost_per_unit)}]);setName('');setUnit(UNITS[0]);setCost('');setInitial('0');setShowNew(false)};
 const beginEdit=(i:number)=>{const x=inventory[i];setEditing(i);setName(x.name);setUnit(unitToLabel(x.unit));setCost(x.cost_per_unit==null?'':String(x.cost_per_unit));};
 const saveEdit=async()=>{if(editing===null)return;const x=inventory[editing];const parsed=cost===''?null:Number(cost);if(!name.trim()|| (parsed!==null && (!Number.isFinite(parsed)||parsed<0)))return;const r=await supabase.from('inventory_items').update({name:name.trim(),unit:unitToCode(unit),cost_per_unit:parsed}).eq('id',x.id);if(r.error)return alert('No se pudo guardar el inventario.');const c=[...inventory];c[editing]={...x,name:name.trim(),unit:unitToCode(unit),cost_per_unit:parsed};setInventory(c);setEditing(null)};
 return <>
   <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><div><div className="text-lg font-extrabold">Insumos</div><div className="text-sm text-slate-500">Agrega nuevos insumos desde aquí; la existencia inicial queda en 0 si no la cambias.</div></div><button className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white" onClick={()=>setShowNew(v=>!v)}>{showNew?'Cerrar':'Agregar insumo'}</button></div>{showNew&&<div className="mt-4 grid gap-3 md:grid-cols-5"><input className="rounded-xl border border-slate-200 p-2.5" placeholder="Nombre" value={name} onChange={e=>setName(e.target.value)}/><select className="rounded-xl border border-slate-200 p-2.5" value={unit} onChange={e=>setUnit(e.target.value)}>{UNITS.map(u=><option key={u}>{u}</option>)}</select><input className="rounded-xl border border-slate-200 p-2.5" type="number" min="0" step=".01" placeholder="Costo de compra" value={cost} onChange={e=>setCost(e.target.value)}/><input className="rounded-xl border border-slate-200 p-2.5" type="number" min="0" step=".001" placeholder="Existencia inicial" value={initial} onChange={e=>setInitial(e.target.value)}/><button className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white" onClick={()=>void addInventory()}>Guardar</button></div>}</div>
   {editing!==null&&<div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-3 text-lg font-extrabold">Editar insumo</div><div className="grid gap-3 md:grid-cols-4"><div><label className="mb-1 block text-xs font-bold text-slate-500">Nombre</label><input className="w-full rounded-xl border border-slate-200 p-2.5" value={name} onChange={e=>setName(e.target.value)}/></div><div><label className="mb-1 block text-xs font-bold text-slate-500">Unidad</label><select className="w-full rounded-xl border border-slate-200 p-2.5" value={unit} onChange={e=>setUnit(e.target.value)}>{UNITS.map(u=><option key={u}>{u}</option>)}</select></div><div><label className="mb-1 block text-xs font-bold text-slate-500">Costo de compra</label><input className="w-full rounded-xl border border-slate-200 p-2.5" type="number" min="0" step=".01" placeholder="0.00" value={cost} onChange={e=>setCost(e.target.value)}/></div><div className="flex items-end gap-2"><button className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white" onClick={()=>void saveEdit()}>Guardar</button><button className="rounded-xl border border-slate-200 px-4 py-2.5 font-bold" onClick={()=>setEditing(null)}>Cancelar</button></div></div></div>}
   <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[1000px]"><thead><tr className="bg-slate-50">{['Insumo','Existencia','Unidad','Costo de compra','Acciones'].map(h=><th key={h} className="px-3 py-3 text-left text-xs text-slate-400">{h}</th>)}</tr></thead><tbody>{inventory.map((x,i)=><tr key={x.id} className="border-t border-slate-100"><td className="px-3 py-3 font-bold">{x.name}</td><td className="px-3 py-3">{x.current_stock}</td><td className="px-3 py-3">{unitToLabel(x.unit)}</td><td className="px-3 py-3">{x.cost_per_unit==null?'—':money(x.cost_per_unit)}</td><td className="px-3 py-3"><button className="mr-2 rounded-lg bg-green-50 px-3 py-2 text-xs font-bold text-green-700" onClick={()=>void movement(i,'compra')}>Agregar</button><button className="mr-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold" onClick={()=>void movement(i,'uso')}>Salió</button><button className="mr-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700" onClick={()=>void movement(i,'merma')}>Merma (se perdió)</button><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold" onClick={()=>beginEdit(i)}>Editar</button></td></tr>)}</tbody></table></div>
   <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800"><strong>Unidades disponibles:</strong> Piezas · Kilogramos (kg) · Litros (L) · Paquete/Caja. Las tortillas se manejan por kilogramo. <strong>Costo de compra</strong> es lo que cuesta comprar el insumo.</div>
 </>;
}

function Empleados({employees,setEmployees,workDays,setWorkDays,locationId,date}:{employees:Employee[];setEmployees:(x:Employee[])=>void;workDays:WorkDay[];setWorkDays:(x:WorkDay[])=>void;locationId:string;date:string}){
 const [n,setN]=useState('');const [phone,setPhone]=useState('');const [pay,setPay]=useState('');
 const add=async()=>{if(!n.trim())return;const r=await supabase.from('itako_employees').insert({location_id:locationId,name:n.trim(),phone,daily_pay_cents:cents(Number(pay||0)),is_active:true});if(r.error)return alert(friendlyError(r.error));setEmployees([...employees,{id:(r.data as any)?.id,name:n.trim(),phone,daily_pay_cents:cents(Number(pay||0)),is_active:true}]);setN('');setPhone('');setPay('')};
 const edit=async(i:number)=>{const e=employees[i];const name=prompt('Nombre',e.name);if(name==null)return;const ph=prompt('Teléfono',e.phone)??e.phone;const p=Number(prompt('Pago por día',String(Number(e.daily_pay_cents||0)/100)));if(!Number.isFinite(p)||p<0)return;const r=await supabase.from('itako_employees').update({name,phone:ph,daily_pay_cents:cents(p)}).eq('id',e.id);if(r.error)return alert(friendlyError(r.error));const c=[...employees];c[i]={...e,name,phone:ph,daily_pay_cents:cents(p)};setEmployees(c)};
 const del=async(i:number)=>{if(!confirm('¿Eliminar este empleado?'))return;const r=await supabase.from('itako_employees').update({is_active:false}).eq('id',employees[i].id);if(r.error)return alert(friendlyError(r.error));setEmployees(employees.filter((_,ix)=>ix!==i))};
 return <><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="grid gap-3 md:grid-cols-4"><input className="rounded-xl border border-slate-200 p-2.5" placeholder="Nombre" value={n} onChange={e=>setN(e.target.value)}/><input className="rounded-xl border border-slate-200 p-2.5" placeholder="Teléfono" value={phone} onChange={e=>setPhone(e.target.value)}/><input className="rounded-xl border border-slate-200 p-2.5" type="number" step=".01" placeholder="Pago por día" value={pay} onChange={e=>setPay(e.target.value)}/><button onClick={()=>void add()} className="rounded-xl bg-red-600 px-4 py-2.5 font-bold text-white">Agregar</button></div></div><div className="my-5"><h2 className="text-[21px] font-extrabold">Personal</h2></div><div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm"><table className="w-full"><thead><tr className="bg-slate-50"><th className="px-3 py-3 text-left text-xs text-slate-400">Nombre</th><th className="px-3 py-3 text-left text-xs text-slate-400">Teléfono</th><th className="px-3 py-3 text-left text-xs text-slate-400">Pago por día</th><th></th></tr></thead><tbody>{employees.map((e,i)=><tr key={e.id} className="border-t border-slate-100"><td className="px-3 py-3 font-bold">{e.name}</td><td className="px-3 py-3">{e.phone}</td><td className="px-3 py-3">{money(Number(e.daily_pay_cents||0)/100)}</td><td className="px-3 py-3"><button onClick={()=>void edit(i)} className="mr-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">Editar</button><button onClick={()=>void del(i)} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Eliminar</button></td></tr>)}</tbody></table></div></>;
}

function Ganancias({locationId,month}:{locationId:string;month:string;nextFloatToday:number}){
 const [rows,setRows]=useState<any[]>([]);const [loading,setLoading]=useState(true);
 useEffect(()=>{(async()=>{setLoading(true);const start=`${month}-01`;const d=new Date(`${start}T12:00:00`);d.setMonth(d.getMonth()+1);d.setDate(0);const end=localDate(d);try{
  const [o,e,r,w,c]=await Promise.all([supabase.from('orders').select('id,business_date,status,subtotal_cents').eq('location_id',locationId).gte('business_date',start).lte('business_date',end),supabase.from('itako_expenses').select('business_date,amount_cents').eq('location_id',locationId).gte('business_date',start).lte('business_date',end),supabase.from('itako_delivery_payouts').select('business_date,amount_cents').eq('location_id',locationId).gte('business_date',start).lte('business_date',end),supabase.from('itako_employee_work_days').select('work_date,pay_cents').eq('location_id',locationId).gte('work_date',start).lte('work_date',end),supabase.from('itako_cash_days').select('business_date,next_day_float_cents').eq('location_id',locationId).gte('business_date',start).lte('business_date',end)]);for(const x of [o,e,r,w,c])if(x.error)throw new Error(x.error.message);const map=new Map<string,any>();for(const row of o.data||[]){if(row.status!=='completed')continue;const a=map.get(row.business_date)||{date:row.business_date,sales:0,expense:0,rider:0,employee:0,float:0};a.sales+=Number(row.subtotal_cents||0)/100;map.set(row.business_date,a)}for(const row of e.data||[]){const a=map.get(row.business_date)||{date:row.business_date,sales:0,expense:0,rider:0,employee:0,float:0};a.expense+=Number(row.amount_cents||0)/100;map.set(row.business_date,a)}for(const row of r.data||[]){const a=map.get(row.business_date)||{date:row.business_date,sales:0,expense:0,rider:0,employee:0,float:0};a.rider+=Number(row.amount_cents||0)/100;map.set(row.business_date,a)}for(const row of w.data||[]){const a=map.get(row.work_date)||{date:row.work_date,sales:0,expense:0,rider:0,employee:0,float:0};a.employee+=Number(row.pay_cents||0)/100;map.set(row.work_date,a)}for(const row of c.data||[]){const a=map.get(row.business_date)||{date:row.business_date,sales:0,expense:0,rider:0,employee:0,float:0};a.float=Number(row.next_day_float_cents||0)/100;map.set(row.business_date,a)}setRows(Array.from(map.values()).sort((a,b)=>a.date.localeCompare(b.date)))}catch(e:any){console.error(e)}finally{setLoading(false)}})()},[locationId,month]);
 const byDay=new Map(rows.map(r=>[r.date,r]));const year=Number(month.slice(0,4));const mon=Number(month.slice(5,7))-1;const first=new Date(year,mon,1);const days=new Date(year,mon+1,0).getDate();const offset=(first.getDay()+6)%7;const cells:Array<any>=Array.from({length:offset+days},()=>null);for(let i=0;i<days;i++)cells[offset+i]=i+1;const sums=rows.reduce((a,r)=>({sales:a.sales+r.sales,expense:a.expense+r.expense,rider:a.rider+r.rider,employee:a.employee+r.employee,net:a.net+(r.sales-r.expense-r.rider-r.employee-r.float)}),{sales:0,expense:0,rider:0,employee:0,net:0});
 return <><div className="itako-grid3 grid grid-cols-3 gap-4"><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">Ventas del mes</div><div className="mt-1 text-3xl font-extrabold">{money(sums.sales)}</div></div><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">Gastos del mes</div><div className="mt-1 text-3xl font-extrabold">{money(sums.expense)}</div></div><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="text-sm text-slate-500">Neto del mes</div><div className="mt-1 text-3xl font-extrabold">{money(sums.net)}</div></div></div><div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-4 text-xl font-extrabold">{new Intl.DateTimeFormat('es-MX',{month:'long',year:'numeric'}).format(first)}</div><div className="itako-calendar grid grid-cols-7 gap-2">{['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d=><div key={d} className="text-center text-xs font-bold text-slate-400">{d}</div>)}{cells.map((n,i)=>{if(!n)return <div key={i} className="min-h-[120px] rounded-xl bg-transparent"/>;const day=`${month}-${String(n).padStart(2,'0')}`;const r=byDay.get(day)||{sales:0,expense:0,rider:0,employee:0,float:0};return <div key={i} className="min-h-[120px] rounded-xl border border-slate-200 p-2"><div className="font-extrabold">{n}</div><div className="mt-1 text-[11px] text-slate-500">Ventas {money(r.sales)}</div><div className="text-[11px] text-slate-500">Gastos {money(r.expense)}</div><div className="text-[11px] text-slate-500">Repartidor {money(r.rider)}</div><div className="text-[11px] text-slate-500">Empleados {money(r.employee)}</div><div className="mt-1 font-extrabold">Quedó {money(r.sales-r.expense-r.rider-r.employee-r.float)}</div></div>})}</div></div></>;
}

async function excelSheetData(date:string,orders:OrderRow[],expenses:ExpenseRow[],employees:Employee[],workDays:WorkDay[],inventory:InventoryRow[],consumptions:StaffConsumption[],totals:any,cashDay:CashDay|null){
 const opening=Number(cashDay?.opening_float_cents||0)/100;
 const next=Number(cashDay?.next_day_float_cents||0)/100;
 const rows:[string, string|number][] = [
  ['Fecha',date],['Total de ventas',totals.sales],['Gastos del día',totals.expenseTotal],['Pagos a repartidores',totals.delivery],['Empleados',totals.payroll],
  ['Fondo de caja inicial',opening],['Efectivo disponible en caja',totals.cashOnHand],['Fondo para mañana',next],['Neto disponible',totals.sales-totals.expenseTotal-totals.delivery-totals.payroll-next],['Cantidad de órdenes',totals.orders]
 ];
 return rows;
}
function escXml(v:any){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')}
function sheet(name:string,headers:string[],rows:any[][]){const h=headers.map(x=>`<Cell><Data ss:Type="String">${escXml(x)}</Data></Cell>`).join('');const body=rows.map(r=>`<Row>${r.map(v=>`<Cell><Data ss:Type="${typeof v==='number'?'Number':'String'}">${escXml(v)}</Data></Cell>`).join('')}</Row>`).join('');return `<Worksheet ss:Name="${escXml(name)}"><Table><Row>${h}</Row>${body}</Table></Worksheet>`}
async function exportExcel({date,orders,expenses,employees,workDays,inventory,consumptions,totals,cashDay}:{date:string;orders:OrderRow[];expenses:ExpenseRow[];employees:Employee[];workDays:WorkDay[];inventory:InventoryRow[];consumptions:StaffConsumption[];totals:any;cashDay:CashDay|null}){
 const summary=await excelSheetData(date,orders,expenses,employees,workDays,inventory,consumptions,totals,cashDay);
 const productCount=new Map<string,number>();
 for(const o of orders.filter(o=>o.status==='Cobrado')) for(const l of o.lines) productCount.set(l.name,(productCount.get(l.name)||0)+l.servedQuantity);
 const xml=`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default"><NumberFormat ss:Format="General"/></Style></Styles>${sheet('Resumen',['Concepto','Valor'],summary)}${sheet('Pedidos',['Orden','Hora','Tipo','Estado','Producto','Cantidad pagada','Gratis','Cantidad entregada','Precio unitario','Importe','Método de pago','Cliente entregó','Cambio','Efectivo en caja'],orders.flatMap(o=>o.lines.map(l=>[o.order_number,new Date(o.created_at).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}),mapType(o.order_type),o.status,l.name,l.quantity,l.freeQuantity,l.servedQuantity,l.unitPrice,l.lineTotal,o.paymentMethod?mapPayment(o.paymentMethod):'',o.amountPaid,o.change,o.cashInBox])))}${sheet('Gastos',['Fecha','Categoría','Monto'],expenses.filter(e=>e.business_date===date).map(e=>[e.business_date,e.category,e.amount]))}${sheet('Empleados',['Nombre','Teléfono','Pago por día','Trabajó hoy'],employees.map(e=>[e.name,e.phone,Number(e.daily_pay_cents||0)/100,workDays.some(w=>w.employee_id===e.id&&w.work_date===date)?'Sí':'No']))}${sheet('Repartidores',['Orden','Monto'],orders.filter(o=>o.order_type==='delivery'&&o.status==='Cobrado').map(o=>[o.order_number,FIXED_DELIVERY_FEE]))}${sheet('Consumo personal',['Empleado','Producto','Cantidad'],consumptions.map(c=>[employees.find(e=>e.id===c.employee_id)?.name||'Personal',c.product_name_snapshot,c.quantity]))}${sheet('Productos vendidos',['Producto','Cantidad entregada'],Array.from(productCount.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([name,q])=>[name,q]))}${sheet('Inventario',['Insumo','Existencia','Unidad','Costo de compra'],inventory.map(i=>[i.name,i.current_stock,unitToLabel(i.unit),i.cost_per_unit??'']))}</Workbook>`;
 const blob=new Blob([xml],{type:'application/vnd.ms-excel'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`itako-corte-${date}.xls`;a.click();URL.revokeObjectURL(a.href);
}
function mapPayment(code:string){return code===PAYMENT_CASH?'Efectivo':code===PAYMENT_TRANSFER?'Transferencia':code}
