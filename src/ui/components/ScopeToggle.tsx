/* ui/components/ScopeToggle.tsx — this month, or everything.

   Every list can be read two ways: the month on screen, which is the working
   view, or the whole history, which is what you go looking for when you want to
   know when something last happened. The Goals tab reads its projection the
   same two ways — the near months or the whole horizon — which is what the
   labels are for. */

export function ScopeToggle({ allTime, onChange, labels, group }: {
  allTime: boolean;
  onChange: (allTime: boolean) => void;
  /** Defaults to “This month” / “All time”. */
  labels?: readonly [string, string];
  /** The group's accessible name. Defaults to “How much to show”. */
  group?: string;
}) {
  const [near, far] = labels ?? ['This month', 'All time'];

  const button = (label: string, wanted: boolean) => (
    <button
      class={`scope-btn${allTime === wanted ? ' is-on' : ''}`}
      aria-pressed={allTime === wanted ? 'true' : 'false'}
      onClick={() => onChange(wanted)}
    >{label}</button>
  );

  return (
    <div class="scope" role="group" aria-label={group ?? 'How much to show'}>
      {button(near, false)}
      {button(far, true)}
    </div>
  );
}
