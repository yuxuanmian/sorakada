import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { t } from "../../i18n";
import { useOverlayContainer } from "../overlay/OverlayRoot";
import { notificationManager, type NotificationEntry, type NotificationManager } from "./notificationManager";
import "./notification.css";

export function notificationText(entry: NotificationEntry, omittedEntries = 0): string {
  const sections: string[] = [];
  sections.push(entry.message ?? t(`notifications.operation.${entry.operation}`));
  sections.push(
    t("notifications.statistics", {
      files: entry.details.length,
      occurrences: entry.occurrences,
      repeats: entry.repeats,
    })
  );
  if (entry.omitted > 0) {
    sections.push(t("notifications.omitted", { count: entry.omitted }));
  }
  if (omittedEntries > 0) {
    sections.push(t("notifications.evicted", { count: omittedEntries }));
  }
  for (const d of entry.details) {
    const detailLines: string[] = [];
    if (d.truncated) {
      detailLines.push(t("notifications.truncated"));
    }
    if (d.context.code) {
      detailLines.push(`${t("notifications.code")}: ${d.context.code}`);
    }
    if (d.context.path) {
      detailLines.push(`${t("notifications.path")}: ${d.context.path}`);
    }
    detailLines.push(d.raw);
    sections.push(detailLines.filter(Boolean).join("\n"));
  }
  return sections.filter(Boolean).join("\n\n");
}

function SoraToast({
  entry,
  omittedEntries,
  manager,
  pause,
}: {
  entry: NotificationEntry;
  omittedEntries: number;
  manager: NotificationManager;
  pause(id: number, value: boolean): void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "copyFailed" | null>(null);

  useEffect(() => {
    pause(entry.id, expanded || hovered || focused);
    return () => pause(entry.id, false);
  }, [entry.id, expanded, hovered, focused, pause]);

  return (
    <article
      className="sora-toast"
      data-level={entry.level}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <div className="sora-toast-heading">
        <strong>{entry.message ?? t(`notifications.operation.${entry.operation}`)}</strong>
        <button type="button" onClick={() => manager.dismiss(entry.id)} aria-label={t("notifications.close")}>
          ×
        </button>
      </div>
      {entry.level === "error" && (
        <>
          <p>
            {t("notifications.statistics", {
              files: entry.details.length,
              occurrences: entry.occurrences,
              repeats: entry.repeats,
            })}
          </p>
          <p className="sora-toast-recent">
            {t("notifications.recent", {
              time: new Date(entry.updatedAt).toLocaleTimeString("zh-CN"),
            })}
          </p>
          {entry.omitted > 0 && <p>{t("notifications.omitted", { count: entry.omitted })}</p>}
          {omittedEntries > 0 && <p>{t("notifications.evicted", { count: omittedEntries })}</p>}
          <div className="sora-toast-actions">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`notification-detail-${entry.id}`}
              onClick={() => setExpanded(!expanded)}
            >
              {t(expanded ? "notifications.hide" : "notifications.details")}
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  if (!navigator.clipboard?.writeText) {
                    setCopyState("copyFailed");
                    return;
                  }
                  navigator.clipboard
                    .writeText(notificationText(entry, omittedEntries))
                    .then(
                      () => setCopyState("copied"),
                      () => setCopyState("copyFailed")
                    );
                } catch {
                  setCopyState("copyFailed");
                }
              }}
            >
              {t("notifications.copy")}
            </button>
          </div>
          {copyState && <p role="status">{t(`notifications.${copyState}`)}</p>}
          {expanded && (
            <pre
              id={`notification-detail-${entry.id}`}
              className="sora-toast-detail"
              tabIndex={0}
            >
              {notificationText(entry, omittedEntries)}
            </pre>
          )}
        </>
      )}
    </article>
  );
}

export function NotificationHost({ manager = notificationManager }: { manager?: NotificationManager }) {
  const { t } = useTranslation();
  const container = useOverlayContainer();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const paused = useRef(new Set<number>());
  const [pause] = useState(() => (id: number, value: boolean) => {
    if (value) paused.current.add(id);
    else paused.current.delete(id);
  });

  useEffect(() => {
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      manager.elapse(Math.min(now - last, 1000), paused.current);
      last = now;
    }, 250);
    return () => clearInterval(timer);
  }, [manager]);

  if (!container) return null;

  return createPortal(
    <section
      className="sora-notifications"
      aria-label={t("notifications.region")}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {snapshot.entries
        .slice(0, 3)
        .map((entry, index) => (
          <SoraToast
            key={entry.id}
            entry={entry}
            omittedEntries={index === 0 ? snapshot.omittedEntries : 0}
            manager={manager}
            pause={pause}
          />
        ))}
    </section>,
    container
  );
}
