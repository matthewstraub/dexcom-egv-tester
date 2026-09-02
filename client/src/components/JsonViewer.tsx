import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

interface JsonViewerProps {
  data: unknown;
  title?: string;
  maxHeight?: string;
}

/**
 * How much JSON we are willing to syntax-highlight and hand to the DOM.
 *
 * Highlighting injects roughly one <span> per token, so cost scales with
 * payload size, not with what is visible. A 28-day EGV response is ~8,000
 * records / ~4MB of pretty-printed JSON, which produced ~261,000 DOM nodes and
 * blocked the main thread for ~9s — long enough that the chart below never got
 * a chance to paint. 60KB keeps that under ~4,000 nodes and ~130ms.
 */
const MAX_HIGHLIGHT_CHARS = 60_000;

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Escape HTML before highlighting — values come from the Dexcom API and are
 *  injected with dangerouslySetInnerHTML. JSON.stringify does not escape < or >. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightJson(json: string): string {
  return escapeHtml(json)
    .replace(
      /("(?:[^"\\]|\\.)*")\s*:/g,
      '<span class="text-[oklch(0.72_0.16_220)]">$1</span>:'
    )
    .replace(
      /:\s*("(?:[^"\\]|\\.)*")/g,
      ': <span class="text-[oklch(0.72_0.15_145)]">$1</span>'
    )
    .replace(
      /:\s*(\d+\.?\d*)/g,
      ': <span class="text-[oklch(0.75_0.12_80)]">$1</span>'
    )
    .replace(
      /:\s*(true|false)/g,
      ': <span class="text-[oklch(0.65_0.2_25)]">$1</span>'
    )
    .replace(
      /:\s*(null)/g,
      ': <span class="text-muted-foreground italic">$1</span>'
    );
}

export function JsonViewer({ data, title, maxHeight = "400px" }: JsonViewerProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const isLarge = jsonString.length > MAX_HIGHLIGHT_CHARS;

  const { preview, previewLines, totalLines } = useMemo(() => {
    const total = countLines(jsonString);
    if (!isLarge) {
      return { preview: jsonString, previewLines: total, totalLines: total };
    }
    const cut = jsonString.slice(0, MAX_HIGHLIGHT_CHARS);
    const lastBreak = cut.lastIndexOf("\n");
    const snapped = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
    return { preview: snapped, previewLines: countLines(snapped), totalLines: total };
  }, [jsonString, isLarge]);

  // Only ever highlight the bounded preview. The full view is plain text so a
  // multi-megabyte payload stays a single text node instead of ~261k elements.
  const highlighted = useMemo(
    () => (showFull ? null : highlightJson(preview)),
    [preview, showFull]
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    toast.success("Copied full response to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border bg-[oklch(0.14_0.012_264)] overflow-hidden">
      {title && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-[oklch(0.17_0.015_264)]">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex min-w-0 items-center gap-2 text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{title}</span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 mr-1 text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 mr-1" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      {!collapsed && (
        <>
          {isLarge && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-2 border-b border-border bg-secondary/20 text-xs font-mono text-muted-foreground">
              <span>
                {showFull ? (
                  <>
                    Showing all{" "}
                    <span className="text-foreground">
                      {totalLines.toLocaleString()}
                    </span>{" "}
                    lines as plain text
                  </>
                ) : (
                  <>
                    Showing first{" "}
                    <span className="text-foreground">
                      {previewLines.toLocaleString()}
                    </span>{" "}
                    of{" "}
                    <span className="text-foreground">
                      {totalLines.toLocaleString()}
                    </span>{" "}
                    lines
                  </>
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowFull(!showFull)}
                className="h-6 shrink-0 px-2 text-[11px] font-mono"
              >
                {showFull ? "Show highlighted preview" : "Show all (plain text)"}
              </Button>
            </div>
          )}
          <div className="overflow-auto p-4" style={{ maxHeight }}>
            <pre className="text-xs font-mono leading-relaxed">
              {showFull ? (
                jsonString
              ) : (
                <code dangerouslySetInnerHTML={{ __html: highlighted! }} />
              )}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
