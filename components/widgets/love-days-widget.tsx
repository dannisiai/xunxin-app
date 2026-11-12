"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Heart } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";
import { useCharacterList } from "@/lib/use-character-list";
import { useLocalDay } from "@/lib/use-local-day";
import { getRelationshipAnniversary, getRelationshipDays, type RelationshipAnniversary } from "@/lib/relationship-dates";

type LoveDaysWidgetProps = {
  config?: Record<string, unknown>;
  widgetId: string;
  preview?: boolean;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
};

function anniversaryLabel(item: RelationshipAnniversary): string {
  if (item.isPast) return `已过 ${item.daysSince} 天`;
  return item.daysRemaining === 0 ? "就是今天" : `还剩 ${item.daysRemaining} 天`;
}

export function LoveDaysWidget({ config, widgetId, preview, onConfigChange }: LoveDaysWidgetProps) {
  const characters = useCharacterList();
  const today = useLocalDay();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [requestedYear, setRequestedYear] = useState("1");
  const configuredId = typeof config?.characterId === "string" ? config.characterId : "";
  const selectedId = configuredId || characters[0]?.id || "";
  const character = characters.find(item => item.id === selectedId);
  const days = getRelationshipDays(character?.createdAt, today);
  const next = days?.anniversaries[0];
  const requested = requestedYear.trim() && /^\d+$/.test(requestedYear)
    ? getRelationshipAnniversary(character?.createdAt, Number(requestedYear), today) : null;

  const showDetails = () => {
    setRequestedYear(String(next?.year || 1));
    setOpen(true);
  };

  return <>
    <div className="wg-love-days">
      <button type="button" className="wg-love-days-button" disabled={preview}
        onClick={showDetails} title="选择角色，查看相爱天数和周年倒计时">
        <span className="wg-love-days-name"><Heart size={11} aria-hidden="true" />
          <span>{character?.name || (configuredId ? "角色已移除，点击重选" : "点击选择角色")}</span>
        </span>
        <span className="wg-love-days-count">{days ? <>相爱第 <strong>{days.dayNumber}</strong> 天</> : "记录我们的每一天"}</span>
        <span className="wg-love-days-next">{next ? `${next.year} 周年 · ${anniversaryLabel(next)}`
          : character ? "创建日期不可用" : "周年倒计时"}</span>
      </button>
    </div>
    {open && !preview && createPortal(
      <ContentDialog title="相爱时间" confirmLabel="完成" cancelLabel=""
        onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}>
        <div className="love-days-details">
          <label htmlFor={`${fieldId}-character`}>显示哪个角色</label>
          <select id={`${fieldId}-character`} value={character ? selectedId : ""}
            disabled={!characters.length || !onConfigChange}
            onChange={event => onConfigChange?.(widgetId, { characterId: event.target.value })}>
            <option value="" disabled>{characters.length ? "请选择角色" : "请先创建角色"}</option>
            {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {days ? <>
            <p className="love-days-summary">和{character?.name}相爱第 <strong>{days.dayNumber}</strong> 天</p>
            <p className="love-days-hint">从 {days.startedOn} 开始，创建角色当天是第 1 天。</p>
            <ul className="love-days-anniversaries">
              {days.anniversaries.map(item => <li key={item.year}>
                <span><b>{item.year} 周年</b><time dateTime={item.date}>{item.date}</time></span>
                <strong>{anniversaryLabel(item)}</strong>
              </li>)}
            </ul>
            <label htmlFor={`${fieldId}-year`}>查看指定周年</label>
            <div className="love-days-year-picker">
              <span>第</span><input id={`${fieldId}-year`} type="number" min="1" max="9999" step="1"
                value={requestedYear} onChange={event => setRequestedYear(event.target.value)} /><span>周年</span>
            </div>
            <p className="love-days-hint" aria-live="polite">{requested
              ? `${requested.date} · ${anniversaryLabel(requested)}` : "请输入有效的正整数周年。"}</p>
            {days.startedOn.endsWith("02-29") && <p className="love-days-hint">闰日创建的角色，平年在 2 月 28 日纪念周年。</p>}
          </> : <p className="love-days-hint">{character ? "这个角色没有有效的创建日期，暂时无法计算。" : "选择一个角色，开始查看你们的相爱天数。"}</p>}
        </div>
      </ContentDialog>, document.body,
    )}
  </>;
}
