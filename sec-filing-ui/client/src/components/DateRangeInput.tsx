import { useEffect, useState } from "react";
import { CalendarIcon, ChevronDown } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// SEC filing dates are plain calendar dates (YYYY-MM-DD); we stay in local
// time so the calendar never shifts a day across timezones.
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYmd(s: string): Date | undefined {
  if (!YMD_RE.test(s)) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  // JS Date silently rolls over invalid dates (e.g. 2026-02-30 → 2026-03-02).
  // Round-trip the components to reject those.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return undefined;
  }
  return dt;
}

const today = () => toYmd(new Date());
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toYmd(d);
};
const startOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  return toYmd(d);
};
const startOfQuarter = () => {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) * 3;
  d.setMonth(q, 1);
  return toYmd(d);
};
const startOfYear = () => {
  const d = new Date();
  d.setMonth(0, 1);
  return toYmd(d);
};

type Preset = { label: string; range: () => { from: string; to: string } };

const PRESETS: Preset[] = [
  { label: "Today", range: () => ({ from: today(), to: today() }) },
  { label: "Yesterday", range: () => ({ from: daysAgo(1), to: daysAgo(1) }) },
  { label: "Last 7 days", range: () => ({ from: daysAgo(6), to: today() }) },
  { label: "Last 30 days", range: () => ({ from: daysAgo(29), to: today() }) },
  { label: "Last 90 days", range: () => ({ from: daysAgo(89), to: today() }) },
  { label: "This month", range: () => ({ from: startOfMonth(), to: today() }) },
  { label: "This quarter", range: () => ({ from: startOfQuarter(), to: today() }) },
  { label: "Year to date", range: () => ({ from: startOfYear(), to: today() }) },
];

type Props = {
  from: string; // canonical YYYY-MM-DD, or "" for open-ended
  to: string;
  onChange: (from: string, to: string) => void;
  className?: string;
  disableFuture?: boolean; // gray out future days in the calendar
};

// First-class date range control: typeable YYYY-MM-DD inputs, a calendar
// popover for visual picking, and a Presets dropdown for the common ranges.
// Designed to replace the bare Calendar-in-Popover pattern that's hard to
// use without a mouse.
export function DateRangeInput({
  from,
  to,
  onChange,
  className,
  disableFuture = true,
}: Props) {
  // Track in-progress edits separately from the canonical YYYY-MM-DD value so
  // partial typing ("2026-") doesn't get rewritten on every keystroke. The
  // canonical value is only committed on blur / Enter / valid parse.
  const [fromText, setFromText] = useState(from);
  const [toText, setToText] = useState(to);
  useEffect(() => setFromText(from), [from]);
  useEffect(() => setToText(to), [to]);

  // Commit the typed values back to the parent. Each input is validated
  // independently; an invalid entry reverts to the last good canonical value.
  // If the resulting range is inverted (from > to), swap so the user doesn't
  // end up with a backwards range silently.
  const commit = (rawFrom: string, rawTo: string) => {
    const trimFrom = rawFrom.trim();
    const trimTo = rawTo.trim();
    let nextFrom = "";
    let nextTo = "";
    if (trimFrom) {
      const d = parseYmd(trimFrom);
      nextFrom = d ? toYmd(d) : from;
    }
    if (trimTo) {
      const d = parseYmd(trimTo);
      nextTo = d ? toYmd(d) : to;
    }
    if (nextFrom && nextTo && nextFrom > nextTo) {
      [nextFrom, nextTo] = [nextTo, nextFrom];
    }
    onChange(nextFrom, nextTo);
  };

  const handleRangeSelect = (range: DateRange | undefined) => {
    onChange(
      range?.from ? toYmd(range.from) : "",
      range?.to ? toYmd(range.to) : "",
    );
  };

  const dateRange: DateRange | undefined =
    from || to ? { from: parseYmd(from), to: parseYmd(to) } : undefined;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <Input
        type="text"
        inputMode="numeric"
        placeholder="YYYY-MM-DD"
        value={fromText}
        onChange={(e) => setFromText(e.target.value)}
        onBlur={() => commit(fromText, toText)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-36 font-mono h-9"
        data-testid="input-date-from"
        aria-label="Start date"
      />
      <span className="text-muted-foreground select-none">→</span>
      <Input
        type="text"
        inputMode="numeric"
        placeholder="YYYY-MM-DD"
        value={toText}
        onChange={(e) => setToText(e.target.value)}
        onBlur={() => commit(fromText, toText)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-36 font-mono h-9"
        data-testid="input-date-to"
        aria-label="End date"
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            data-testid="button-date-calendar"
            aria-label="Open calendar"
          >
            <CalendarIcon className="w-4 h-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            numberOfMonths={2}
            defaultMonth={dateRange?.from}
            selected={dateRange}
            onSelect={handleRangeSelect}
            disabled={disableFuture ? { after: new Date() } : undefined}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-9"
            data-testid="button-date-presets"
          >
            Presets <ChevronDown className="w-3 h-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          {PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.label}
              onSelect={() => {
                const r = p.range();
                onChange(r.from, r.to);
              }}
              data-testid={`preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {p.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onChange("", "")}
            data-testid="preset-clear"
          >
            Clear (all dates)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
