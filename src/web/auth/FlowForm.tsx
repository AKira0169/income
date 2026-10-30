/* auth/FlowForm.tsx — one renderer for every Kratos flow.

   Kratos describes each form as a list of nodes — inputs, the hidden CSRF
   token, buttons, the TOTP QR image, the secret beside it, backup codes — each
   with its own messages, and the form with messages of its own. Drawing them
   generically means a method switched on in kratos.yml shows up here without a
   line of screen code. Values go in as defaultValue, as in every form in this
   app (see ui/components/Form.tsx): a redraw must never eat what was typed. */

import { useState } from 'preact/hooks';
import { bodyFromForm, submitFlow } from './kratos.ts';
import type { Flow, Outcome, UiNode, UiText } from './kratos.ts';

export interface FlowFormProps {
  flow: Flow;
  /** The node groups to show; `default` (the CSRF token) always comes along. Omit for all. */
  groups?: readonly string[];
  onOutcome: (outcome: Outcome) => void;
}

function Messages({ list }: { list?: UiText[] }) {
  if (!list?.length) return null;
  return <>{list.map((m) => <p key={`${m.id}${m.text}`} class={`auth-message is-${m.type}`}>{m.text}</p>)}</>;
}

function Node({ node, busy }: { node: UiNode; busy: boolean }) {
  const a = node.attributes;
  const label = node.meta.label?.text;

  if (node.type === 'img') {
    return (
      <div class="auth-node" data-node-id={a.id}>
        <img src={a.src} width={a.width} height={a.height} alt={label ?? ''} />
      </div>
    );
  }
  if (node.type === 'text') {
    const secrets = (a.text?.context as { secrets?: { text: string }[] } | undefined)?.secrets;
    return (
      <div class="auth-node" data-node-id={a.id}>
        {label ? <span class="muted">{label}</span> : null}
        {secrets
          ? <ul class="auth-codes">{secrets.map((s) => <li key={s.text}><code>{s.text}</code></li>)}</ul>
          : <code class="auth-secret">{a.text?.text}</code>}
        <Messages list={node.messages} />
      </div>
    );
  }
  if (node.type === 'a') {
    return <p class="auth-node" data-node-id={a.id}><a href={a.href}>{a.title?.text ?? a.href}</a></p>;
  }
  if (node.type !== 'input') return null;

  if (a.type === 'hidden') return <input type="hidden" name={a.name} value={String(a.value ?? '')} />;
  if (a.type === 'submit' || a.type === 'button') {
    return (
      <button class="primary" type="submit" name={a.name} value={String(a.value ?? '')}
        disabled={busy || a.disabled} data-node-id={a.name}>
        {label ?? 'Continue'}
      </button>
    );
  }
  if (a.type === 'checkbox') {
    return (
      <label class="check auth-node" data-node-id={a.name}>
        <input type="checkbox" name={a.name} value="true" defaultChecked={a.value === true} disabled={a.disabled} />
        {label}
        <Messages list={node.messages} />
      </label>
    );
  }
  return (
    <label class="auth-field auth-node" data-node-id={a.name}>
      <span>{label ?? a.name}</span>
      <input
        name={a.name} type={a.type} required={a.required} disabled={a.disabled}
        autocomplete={a.autocomplete} pattern={a.pattern}
        defaultValue={a.value === undefined || a.value === null ? '' : String(a.value)}
      />
      <Messages list={node.messages} />
    </label>
  );
}

export function FlowForm({ flow, groups, onOutcome }: FlowFormProps) {
  const [busy, setBusy] = useState(false);
  const shown = flow.ui.nodes.filter((n) => !groups || n.group === 'default' || groups.includes(n.group));
  if (groups && !shown.some((n) => n.group !== 'default')) return null;

  return (
    <form
      class="auth-form" method="post" action={flow.ui.action}
      onSubmit={(e: Event) => {
        e.preventDefault();
        if (busy) return;
        const form = e.currentTarget as HTMLFormElement;
        const pressed = (e as SubmitEvent).submitter as HTMLButtonElement | null;
        const body = bodyFromForm(shown, new FormData(form), pressed ? { name: pressed.name, value: pressed.value } : null);
        setBusy(true);
        void submitFlow(flow, body)
          .then(onOutcome, () => onOutcome({ kind: 'restart', reason: 'Could not reach the sign-in service.' }))
          .finally(() => setBusy(false));
      }}
    >
      <Messages list={flow.ui.messages} />
      {shown.map((n, i) => (
        <Node key={`${n.attributes.name ?? n.attributes.id ?? ''}:${String(n.attributes.value ?? '')}:${i}`} node={n} busy={busy} />
      ))}
    </form>
  );
}
