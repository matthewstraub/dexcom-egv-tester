import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChartRange } from "@/lib/chartAxis";
import { trpc } from "@/lib/trpc";
import { CHART_RANGE_DEFAULT, CHART_RANGE_LIMITS } from "../../../shared/const";

/** Why a range can't be saved, or null if it can. Mirrors the server's chartRangeSchema. */
function rangeProblem(min: number, max: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return "Use whole numbers.";
  if (min < CHART_RANGE_LIMITS.lowest || max > CHART_RANGE_LIMITS.highest) {
    return `Keep the range within ${CHART_RANGE_LIMITS.lowest}–${CHART_RANGE_LIMITS.highest} mg/dL.`;
  }
  if (max - min < CHART_RANGE_LIMITS.minSpan) {
    return `The maximum must be at least ${CHART_RANGE_LIMITS.minSpan} above the minimum.`;
  }
  return null;
}

/**
 * Admin-only control for the EGV chart's vertical range. The range is saved
 * on the server, so it applies to everyone who signs in.
 */
export function ChartRangeControl({ range }: { range: ChartRange }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(String(range.min));
  const [max, setMax] = useState(String(range.max));

  // Start from the saved range each time the panel opens.
  useEffect(() => {
    if (open) {
      setMin(String(range.min));
      setMax(String(range.max));
    }
  }, [open, range.min, range.max]);

  const save = trpc.settings.setChartRange.useMutation({
    onSuccess: (saved) => {
      utils.settings.get.setData(undefined, { chartRange: saved });
      toast.success(`Chart range set to ${saved.min}–${saved.max} mg/dL`);
      setOpen(false);
    },
    onError: () => toast.error("Couldn't save the chart range."),
  });

  const problem = rangeProblem(Number(min), Number(max));
  const isDefault = Number(min) === CHART_RANGE_DEFAULT.min && Number(max) === CHART_RANGE_DEFAULT.max;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 px-2 text-xs font-mono gap-1.5" aria-label="Chart range">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {range.min}–{range.max}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3">
        <div>
          <p className="text-sm font-medium">Chart range</p>
          <p className="text-xs text-muted-foreground mt-1">
            The vertical axis, in mg/dL, for everyone. It still widens to show any reading outside it.
          </p>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) save.mutate({ min: Number(min), max: Number(max) });
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-xs font-mono text-muted-foreground">Min</span>
              <Input type="number" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} className="font-mono text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-mono text-muted-foreground">Max</span>
              <Input type="number" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} className="font-mono text-sm" />
            </label>
          </div>
          {problem && <p className="text-xs text-amber-400">{problem}</p>}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={isDefault}
              onClick={() => {
                setMin(String(CHART_RANGE_DEFAULT.min));
                setMax(String(CHART_RANGE_DEFAULT.max));
              }}
            >
              Reset to {CHART_RANGE_DEFAULT.min}–{CHART_RANGE_DEFAULT.max}
            </Button>
            <Button type="submit" size="sm" className="h-8" disabled={!!problem || save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
