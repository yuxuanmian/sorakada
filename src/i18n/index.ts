import i18next from "i18next";
import type { ParseKeys, TFunction } from "i18next";
import { initReactI18next } from "react-i18next";
import { enCore, zhCore } from "./locales/core";
import { enUi, zhUi } from "./locales/ui";
import { enDialogs, zhDialogs } from "./locales/dialogs";
import { enNotifications, zhNotifications } from "./locales/notifications";

export const resources = {
  "zh-CN": { translation: { core: zhCore, ui: zhUi, dialogs: zhDialogs, notifications: zhNotifications } },
  "en-US": { translation: { core: enCore, ui: enUi, dialogs: enDialogs, notifications: enNotifications } },
} as const;

export const i18n = i18next.createInstance();
// Bundled resources initialise synchronously: no detector, storage or language UI.
void i18n.use(initReactI18next).init({
  resources,
  lng: "zh-CN",
  fallbackLng: "en-US",
  defaultNS: "translation",
  initAsync: false,
  interpolation: { escapeValue: false },
});

/** Read at call time; non-React models must never cache translated labels. */
export const t = i18n.t.bind(i18n);

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof resources["zh-CN"]["translation"] };
    returnNull: false;
  }
}

export type TranslationKey = ParseKeys<"translation">;
export type AppTranslator = TFunction<"translation", undefined>;
