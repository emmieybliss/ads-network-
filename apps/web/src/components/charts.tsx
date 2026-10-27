'use client';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const axis = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--fg)' };

export interface SeriesDef { key: string; label: string; color: string; format?: (v: number) => string }

/** Daily trend. Data rows carry `label` (the date) plus one numeric field per series. */
export function TrendChart({ data, series, height = 260 }: { data: Array<Record<string, unknown>>; series: SeriesDef[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, day: String(d.label ?? d.key).slice(5) }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={0.25} />
                <stop offset="1" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" {...axis} minTickGap={16} />
          <YAxis {...axis} allowDecimals={false} width={56} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => {
            const s = series.find((x) => x.label === name);
            return [s?.format ? s.format(Number(v)) : Number(v).toLocaleString(), name];
          }} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} fill={`url(#g-${s.key})`} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BreakdownBars({ data, valueKey, label, color = 'var(--chart-1)', height = 220 }: { data: Array<Record<string, unknown>>; valueKey: string; label: string; color?: string; height?: number }) {
  const rows = data.slice(0, 8).map((d) => ({ name: String(d.label ?? d.key ?? '—'), value: Number(d[valueKey] ?? 0) }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" horizontal={false} />
          <XAxis type="number" {...axis} allowDecimals={false} />
          <YAxis type="category" dataKey="name" {...axis} width={130} tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => [Number(v).toLocaleString(), label]} />
          <Bar dataKey="value" name={label} fill={color} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
