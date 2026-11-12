"use client";

import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { usePaneSize } from "./use-pane-size";
import { PaneResizeHandle } from "./pane-resize-handle";
import { clampPaneWidth, getTabletLayout } from "@/lib/tablet-layout";

export type WorkspaceDestination = { id: string; label: string; icon?: ReactNode; description?: string };

/** A persistent navigation pane. Container queries change presentation without remounting the editor. */
export function AdaptiveWorkspace({ title, destinations, selected, onSelect, onClose, children, className = "", backLabel = "返回桌面" }: {
  title: string;
  destinations: WorkspaceDestination[];
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  backLabel?: string;
}) {
  const pane = usePaneSize();
  const navId = useId();
  const [navigation, setNavigation] = useState<"auto" | "rail" | "expanded">("auto");
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const layout = getTabletLayout(pane.width);
  const expanded = navigation === "expanded" || (navigation === "auto" && layout.expandedNavigation);
  const width = clampPaneWidth(customWidth ?? layout.navigationWidth, pane.width);
  const visible = expanded && search.trim()
    ? destinations.filter(item => `${item.label} ${item.description || ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : destinations;
  return <div ref={pane.ref} className={`adaptive-workspace ${className}`} data-navigation={navigation}
    style={{ "--workspace-navigation-width": `${width || 240}px` } as CSSProperties}>
    <nav id={navId} className="adaptive-workspace-nav" aria-label={`${title}分类`}>
      <button type="button" className="adaptive-workspace-home" onClick={onClose} aria-label={backLabel} title={backLabel}><ChevronLeft size={20} /><span>{backLabel.replace(/^返回/, "")}</span></button>
      <h2>{title}</h2>
      <button type="button" className="adaptive-workspace-toggle" aria-label={expanded ? "收起侧栏" : "展开侧栏"}
        aria-expanded={expanded} aria-controls={navId} title={expanded ? "收起侧栏" : "展开侧栏"}
        onClick={() => { setNavigation(expanded ? "rail" : "expanded"); setSearch(""); }}>
        {expanded ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}<span>收起侧栏</span>
      </button>
      {destinations.length > 8 && <label className="adaptive-workspace-search"><Search size={16} aria-hidden="true" />
        <input aria-label={`搜索${title}分类`} placeholder="搜索" value={search} onChange={event => setSearch(event.target.value)} />
      </label>}
      <div className="adaptive-destination-list" onKeyDown={navigateDestinationKeys}>
        {visible.map(item => <button type="button" key={item.id} className="adaptive-destination" title={item.label} aria-label={item.label}
          aria-current={selected === item.id ? "page" : undefined}
          onClick={() => onSelect(item.id)}>
          <span className="adaptive-destination-icon" aria-hidden="true">{item.icon || <span className="adaptive-destination-monogram">{/^\d+$/.test(item.id) ? Number(item.id) + 1 : Array.from(item.label)[0]}</span>}</span>
          <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
        </button>)}
      </div>
      {visible.length === 0 && <p className="adaptive-workspace-no-results">没有匹配的分类</p>}
    </nav>
    <PaneResizeHandle className="adaptive-workspace-divider" label="调整侧栏宽度" value={width}
      min={clampPaneWidth(220, pane.width)} max={clampPaneWidth(360, pane.width)} onChange={setCustomWidth} />
    <div className="adaptive-workspace-content">{children}</div>
  </div>;
}

/** Arrow keys move focus; Enter/Space retain standard button activation. Tab can leave the navigation. */
export function navigateDestinationKeys(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      || (event.target as HTMLElement).matches('input,textarea,select,[contenteditable="true"]')) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    .filter(button => button.getClientRects().length > 0);
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0 || !buttons.length) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (current + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next].focus();
}

/** Spatial navigation follows rendered positions, so widgets and gaps need no separate grid model. */
export function navigateIconGridKeys(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('button.icon-item');
  if (!button || target.closest('input,textarea,select,[contenteditable="true"]')) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.icon-item:not(:disabled)')]
    .filter(node => !node.closest('[inert],[aria-hidden="true"]') && node.getClientRects().length > 0);
  let next: HTMLButtonElement | undefined;
  if (event.key === 'Home') next = buttons[0];
  else if (event.key === 'End') next = buttons.at(-1);
  else {
    const rect = button.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const horizontal = ['ArrowLeft','ArrowRight'].includes(event.key), sign = ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1;
    next = buttons.filter(node => node !== button).map(node => {
      const bounds = node.getBoundingClientRect(), dx = bounds.left + bounds.width / 2 - x, dy = bounds.top + bounds.height / 2 - y;
      const forward = (horizontal ? dx : dy) * sign, across = Math.abs(horizontal ? dy : dx);
      return { node, forward, score: forward + across * 4 };
    }).filter(item => item.forward > 1).sort((a, b) => a.score - b.score)[0]?.node;
  }
  if (next) { event.preventDefault(); next.focus(); }
}
