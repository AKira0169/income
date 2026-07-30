/* ui/components/ScopeToggle.tsx — this month, or everything.

   Every list can be read two ways: the month on screen, which is the working
   view, or the whole history, which is what you go looking for when you want to
   know when something last happened. */

export function ScopeToggle({ allTime, onChange }: {
  allTime: boolean;
  onChange: (allTime: boolean) => void;
}) {
  const button = (label: string, wanted: boolean) => (
    <button
      class={`scope-btn${allTime === wanted ? ' is-on' : ''}`}
      aria-pressed={allTime === wanted ? 'true' : 'false'}
      onClick={() => onChange(wanted)}
    >{label}</button>
  );

  return (
    <div class="scope" role="group" aria-label="How much to show">
      {button('This month', false)}
      {button('All time', true)}
    </div>
  );
}
