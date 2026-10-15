import { useEffect, useRef, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import type { EscapeManager } from "../../app/commands/escapeManager";
import { ESCAPE_PRIORITY } from "../../app/commands/escapeManager";
import { useOverlayContainer } from "../overlay/OverlayRoot";
import { dialogManager, type ActiveDialog, type DialogManager } from "./dialogManager";
import "./dialog.css";

export function SoraDialog({ request, manager }: { request: ActiveDialog; manager: DialogManager }) {
  useTranslation();
  const container = useOverlayContainer();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog.Root
      open
      modal
      onOpenChange={open => {
        if (!open) {
          manager.choose(request.id, request.cancelValue);
        }
      }}
    >
      <Dialog.Portal container={container}>
        <Dialog.Backdrop className="sora-dialog-backdrop" />
        <Dialog.Viewport className="sora-dialog-viewport">
          <Dialog.Popup
            className="sora-dialog"
            initialFocus={cancelRef}
            finalFocus={() => {
              if (manager.isActive()) return false;
              const target = request.returnFocus;
              if (
                target &&
                target.isConnected &&
                typeof target.focus === "function" &&
                target !== document.body &&
                !target.closest?.(".sora-dialog")
              ) {
                return target;
              }
              return false;
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.stopPropagation();
              }
            }}
          >
            <Dialog.Title className="sora-dialog-title">{request.title()}</Dialog.Title>
            <Dialog.Description className="sora-dialog-message">{request.message()}</Dialog.Description>
            <div className="sora-dialog-actions">
              {request.buttons.map(button =>
                button.value === request.cancelValue ? (
                  <Dialog.Close
                    key={button.value}
                    ref={cancelRef}
                    className="sora-dialog-button"
                    onClick={() => manager.choose(request.id, button.value)}
                  >
                    {button.label()}
                  </Dialog.Close>
                ) : (
                  <button
                    key={button.value}
                    type="button"
                    className="sora-dialog-button"
                    data-dangerous={button.dangerous || undefined}
                    onClick={() => manager.choose(request.id, button.value)}
                  >
                    {button.label()}
                  </button>
                )
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DialogHost({
  manager = dialogManager,
  escapeManager,
}: {
  manager?: DialogManager;
  escapeManager?: EscapeManager;
}) {
  const request = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  useEffect(() => manager.attach(), [manager]);
  useEffect(
    () =>
      escapeManager?.register(ESCAPE_PRIORITY.MODAL, () => {
        if (!manager.getSnapshot()) return false;
        manager.cancel();
        return true;
      }),
    [escapeManager, manager]
  );
  return request ? <SoraDialog key={request.id} request={request} manager={manager} /> : null;
}
