import { useId, useRef, useState, type FormEvent } from "react";
import type { SendInput } from "@isocline/module-mail/types";
import { Icon } from "./shell/icons.tsx";
import { Select } from "./shell/Select.tsx";
import { t } from "./i18n/index.ts";

interface Props {
  input: SendInput;
  accounts: string[];
  busy: boolean;
  onChange(input: SendInput): void;
  onBack(): void;
  onDiscard(): void;
  onSend(input: SendInput): Promise<void>;
}

export function NewMail({ input, accounts, busy, onChange, onBack, onDiscard, onSend }: Props) {
  const [error, setError] = useState("");
  const [showCc, setShowCc] = useState(() => input.cc.some(Boolean));
  const ccId = useId();
  const ccField = useRef<HTMLInputElement>(null);
  const account = input.account || accounts[0] || "";
  const canSend = accounts.includes(account);
  const change = (patch: Partial<SendInput>) => {
    setError("");
    onChange({ ...input, account, ...patch });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canSend || !input.body.trim()) return;
    const addresses = (values: string[]) => values.map((value) => value.trim().toLowerCase()).filter(Boolean);
    const to = addresses(input.to), cc = addresses(input.cc);
    if (!to.length) return;
    if (to.length + cc.length > 20) { setError(t("mail.tooManyRecipients")); return; }
    setError("");
    try { await onSend({ account, to, cc, subject: input.subject, body: input.body }); }
    catch (reason) { setError((reason as Error).message); }
  };
  return (
    <form className="mail-editor" onSubmit={submit} aria-label={t("mail.compose.about")}>
      <header className="mail-editor-heading">
        <div className="mail-editor-title">
          <button type="button" className="mail-editor-back" aria-label={t("mail.back")} onClick={onBack}><Icon name="back" /></button>
          <h2>{t("mail.compose.about")}</h2>
        </div>
        <div className="mail-sender">
          <span>{t("mail.from")}</span>
          {accounts.length > 1 || (!canSend && accounts.length > 0) ? (
            <Select className="mail-sender-pick" label={t("mail.from")} value={account} disabled={busy} onChange={(next) => change({ account: next })}
              options={[...(!canSend ? [{ value: account, label: account, disabled: true }] : []), ...accounts.map((address) => ({ value: address, label: address }))]} />
          ) : <span className="mail-sender-address" title={account}>{account || t("mail.noSender")}</span>}
        </div>
      </header>
      <fieldset className="mail-sheet" disabled={busy}>
        <div className="mail-envelope">
          <div className="mail-address-row">
            <label>{t("mail.to")}
              <input type="email" multiple required autoFocus placeholder={t("mail.addressPlaceholder")} value={input.to.join(",")} onChange={(event) => change({ to: event.target.value.split(",") })} />
            </label>
            {!showCc && <button type="button" className="mail-add-cc" aria-controls={ccId} aria-expanded={false} onClick={() => {
              setShowCc(true);
              requestAnimationFrame(() => ccField.current?.focus());
            }}>{t("mail.cc")}</button>}
          </div>
          <div className="mail-address-row" id={ccId} hidden={!showCc}>
            <label>{t("mail.cc")}
              <input ref={ccField} type="email" multiple placeholder={t("mail.addressPlaceholder")} value={input.cc.join(",")} onChange={(event) => change({ cc: event.target.value.split(",") })} />
            </label>
          </div>
        </div>
        <input className="mail-editor-subject" aria-label={t("mail.subject")} placeholder={t("mail.subject")} value={input.subject} maxLength={500} onChange={(event) => change({ subject: event.target.value })} />
        <textarea className="mail-editor-message" aria-label={t("mail.body")} placeholder={t("mail.bodyPlaceholder")} rows={5} required maxLength={20_000} value={input.body} onChange={(event) => change({ body: event.target.value })} />
        {!canSend && <a className="mail-editor-notice small" href="#p=core.settings">{t("mail.nosend")}</a>}
        {error && <p className="mail-editor-notice problem small" role="alert">{error}</p>}
        <footer className="mail-sendbar">
          <button type="submit" className="mail-send" disabled={!canSend || !input.to.some((value) => value.trim()) || !input.body.trim()}><Icon name="sendMail" />{t(busy ? "mail.sent.going" : "mail.send")}</button>
          <button type="button" className="mail-discard" onClick={onDiscard}><Icon name="trash" />{t("mail.discardDraft")}</button>
        </footer>
      </fieldset>
    </form>
  );
}
