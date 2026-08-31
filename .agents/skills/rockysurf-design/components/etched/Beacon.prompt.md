Replaces StepList in the etched skin. The cone is the progress; the crossing strokes are the steps, dashed while unreached and pulsing at the current one.

```jsx
<Beacon steps={STEP_ORDER} current="installing_tools" labels={STEP_LABELS} />
```
An unrecognised `current` leaves the beam unlit rather than resetting it — same rule as StepList.
