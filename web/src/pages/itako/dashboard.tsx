import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, CircleDollarSign, ClipboardList, CreditCard, Banknote, Truck, ReceiptText, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';
import { useDateTime, useMoney } from '@/context/locale-context';
import { supabase } from '@/services/supabase-client';
import { cn } from '@/lib/utils';

interface DayOrder { id: string; order_number: string; total_cents: number; delivery_fee_cents: number; order_type: string; created_at: string; }
interface Payment { order_id: string; payment_method_code: string; amount_paid_cents: number; change_given_cents: number; payment_status: string; }
interface Expense { id: string; category: string; description: string; amount_cents: number; payment_method_code: string; order_id?: string | null; created_at: string; }
interface SoldLine { item_id: string; quantity: number; item_name: string; }

export default function ItakoDashboard() {
  const { activeLocation } = useAuth();
  const { today, formatDate } = useDateTime();
  const { format } = useMoney();
  const [orders, setOrders] = useState<DayOrder[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [sold, setSold] = useState<SoldLine[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeLocation?.id) return;
    setLoading(true);
    const day = today();
    const start = `${day}T00:00:00`;
    const end = `${day}T23:59:59.999`;
    try {
      const [ordersRes, expensesRes] = await Promise.all([
        supabase.from('orders').select('id, order_number, total_cents, delivery_fee_cents, order_type, created_at').eq('location_id', activeLocation.id).gte('created_at', start).lte('created_at', end).neq('status', 'cancelled').order('created_at', { ascending: false }),
        supabase.from('itako_expenses').select('id, category, description, amount_cents, payment_method_code, order_id, created_at').eq('location_id', activeLocation.id).gte('created_at', start).lte('created_at', end).order('created_at', { ascending: false }),
      ]);
      if (ordersRes.error) throw ordersRes.error;
      if (expensesRes.error) throw expensesRes.error;
      const os = (ordersRes.data || []) as DayOrder[];
      const es = (expensesRes.data || []) as Expense[];
      setOrders(os); setExpenses(es);
      if (os.length) {
        const ids = os.map(o => o.id);
        const [payRes, itemRes] = await Promise.all([
          supabase.from('order_payments').select('order_id, payment_method_code, amount_paid_cents, change_given_cents, payment_status').in('order_id', ids).eq('payment_status', 'completed'),
          supabase.from('order_items').select('item_id, quantity, items(name)').in('order_id', ids),
        ]);
        if (payRes.error) throw payRes.error;
        if (itemRes.error) throw itemRes.error;
        setPayments((payRes.data || []) as Payment[]);
        const map = new Map<string, SoldLine>();
        for (const row of (itemRes.data || []) as Array<{ item_id: string; quantity: number; items?: { name?: string } | null }>) {
          const key = row.item_id;
          const old = map.get(key);
          map.set(key, { item_id: key, quantity: (old?.quantity || 0) + Number(row.quantity || 0), item_name: row.items?.name || 'Producto' });
        }
        setSold(Array.from(map.values()).sort((a,b) => b.quantity - a.quantity));
      } else { setPayments([]); setSold([]); }
    } catch (e) {
      console.error('Itako dashboard load failed', e);
    } finally { setLoading(false); }
  }, [activeLocation?.id, today]);

  useEffect(() => { void load(); }, [load]);

  const sales = orders.reduce((s, o) => s + Number(o.total_cents || 0), 0);
  const deliveryFees = orders.filter(o => o.order_type === 'delivery').reduce((s, o) => s + Number(o.delivery_fee_cents || 0), 0);
  const deliveryPayouts = expenses.filter(e => e.category === 'Repartidor').reduce((s,e) => s + Number(e.amount_cents || 0), 0);
  const expensesTotal = expenses.reduce((s,e) => s + Number(e.amount_cents || 0), 0);
  const cash = payments.filter(p => p.payment_method_code === 'cash').reduce((s,p) => s + Number(p.amount_paid_cents || 0) - Number(p.change_given_cents || 0), 0);
  const transfer = payments.filter(p => p.payment_method_code === 'eft').reduce((s,p) => s + Number(p.amount_paid_cents || 0), 0);
  const result = sales - expensesTotal;

  const topSold = useMemo(() => sold.slice(0, 8), [sold]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#B91C1C]">ITAKO</p>
          <h1 className="text-3xl font-black tracking-tight text-[#1F2937]">Resumen de hoy</h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1"><CalendarDays className="h-4 w-4" />{formatDate(new Date(), { dateStyle: 'long' })}</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} />Actualizar</Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={CircleDollarSign} label="Vendido" value={format(sales)} />
        <Stat icon={ClipboardList} label="Órdenes" value={String(orders.length)} />
        <Stat icon={Banknote} label="Efectivo" value={format(cash)} />
        <Stat icon={CreditCard} label="Transferencias" value={format(transfer)} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 border-0 shadow-sm bg-white">
          <CardHeader><CardTitle className="text-lg">Corte del día</CardTitle></CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-3">
            <NumberRow label="Total vendido" value={format(sales)} strong />
            <NumberRow label="Gastos" value={`- ${format(expensesTotal)}`} />
            <NumberRow label="Envío cobrado a clientes" value={format(deliveryFees)} />
            <NumberRow label="Pago a repartidores" value={`- ${format(deliveryPayouts)}`} />
            <div className="sm:col-span-2 mt-2 rounded-2xl bg-[#1F2937] text-white p-5 flex items-center justify-between"><span className="font-semibold">Queda después de gastos</span><span className="text-3xl font-black tabular-nums">{format(result)}</span></div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm bg-white">
          <CardHeader><CardTitle className="text-lg">Lo más vendido hoy</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topSold.length === 0 ? <p className="text-sm text-muted-foreground">Todavía no hay ventas.</p> : topSold.map((x) => <div key={x.item_id} className="flex justify-between gap-3 py-2 border-b last:border-0"><span className="truncate">{x.item_name}</span><strong>{x.quantity}</strong></div>)}
          </CardContent>
        </Card>
      </div>

      <Card className="border-0 shadow-sm bg-white">
        <CardHeader><CardTitle className="text-lg">Últimas órdenes</CardTitle></CardHeader>
        <CardContent>
          {orders.length === 0 ? <p className="text-sm text-muted-foreground">No hay órdenes hoy.</p> : <div className="divide-y">{orders.slice(0, 12).map(o => <div key={o.id} className="flex items-center justify-between gap-3 py-3"><div><p className="font-semibold">#{o.order_number}</p><p className="text-xs text-muted-foreground">{o.order_type === 'delivery' ? 'Entrega' : 'En local'} · {new Date(o.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</p></div><span className="font-bold tabular-nums">{format(o.total_cents)}</span></div>)}</div>}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof CircleDollarSign; label: string; value: string }) {
  return <Card className="border-0 shadow-sm bg-white"><CardContent className="p-5"><Icon className="h-5 w-5 text-[#B91C1C] mb-3" /><p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label}</p><p className="text-2xl font-black text-[#1F2937] tabular-nums mt-1">{value}</p></CardContent></Card>;
}
function NumberRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) { return <div className="flex items-center justify-between rounded-xl bg-[#F7F3EA] px-4 py-3"><span className={strong ? 'font-bold' : 'text-muted-foreground'}>{label}</span><span className={cn('tabular-nums', strong ? 'font-black text-lg' : 'font-semibold')}>{value}</span></div>; }
