# Design System

## Direction

Compact desktop utility panel for focused configuration work. The visual mood is a late-evening developer desk: white work surface, ink-black text, restrained plum primary, and a small electric blue status cue.

## Palette

```css
--bg: oklch(0.985 0 0);
--surface: oklch(1 0 0);
--surface-subtle: oklch(0.965 0.008 355);
--ink: oklch(0.23 0.025 300);
--muted: oklch(0.48 0.025 300);
--line: oklch(0.88 0.018 355);
--primary: oklch(0.47 0.16 355);
--primary-strong: oklch(0.39 0.15 355);
--accent: oklch(0.62 0.17 245);
--success: oklch(0.52 0.14 155);
--warning: oklch(0.68 0.14 75);
--danger: oklch(0.55 0.18 25);
```

## Typography

System sans stack, 12px compact labels, 13px body controls, 16px section titles, 22px product title. Use weight and spacing for hierarchy, not display fonts.

## Components

- Side panel with a quiet top bar and a compact current-page strip.
- Profile rows with one primary action and a visible enabled state.
- Rule rows with target chip, action type, value, and one remove control.
- Inline status messages for permission, picker, save, and execution states.
- Full-width primary buttons, subtle secondary buttons, 8–12px radius, visible keyboard focus.

## Interaction

Use 150–220ms ease-out transitions. Picker mode gets a page overlay and Escape cancellation. Automatic submission is opt-in per profile and never inferred from a selected button.
