import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

interface JsonViewerProps {
  data: unknown;
  title?: string;
  maxHeight?: string;
}

export function JsonViewer({ data, title, maxHeight = "400px" }: JsonViewerProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border bg-[oklch(0.14_0.012_264)] overflow-hidden">
      {title && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-[oklch(0.17_0.015_264)]">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-2 text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {title}
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
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
        <div
          className="overflow-auto p-4"
          style={{ maxHeight }}
        >
          <pre className="text-xs font-mono leading-relaxed">
            <SyntaxHighlightedJson json={jsonString} />
          </pre>
        </div>
      )}
    </div>
  );
}

function SyntaxHighlightedJson({ json }: { json: string }) {
  // Simple syntax highlighting for JSON
  const highlighted = json.replace(
    /("(?:[^"\\]|\\.)*")\s*:/g,
    '<span class="text-[oklch(0.72_0.16_220)]">$1</span>:'
  ).replace(
    /:\s*("(?:[^"\\]|\\.)*")/g,
    ': <span class="text-[oklch(0.72_0.15_145)]">$1</span>'
  ).replace(
    /:\s*(\d+\.?\d*)/g,
    ': <span class="text-[oklch(0.75_0.12_80)]">$1</span>'
  ).replace(
    /:\s*(true|false)/g,
    ': <span class="text-[oklch(0.65_0.2_25)]">$1</span>'
  ).replace(
    /:\s*(null)/g,
    ': <span class="text-muted-foreground italic">$1</span>'
  );

  return <code dangerouslySetInnerHTML={{ __html: highlighted }} />;
}
