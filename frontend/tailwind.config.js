/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Colours are CSS variables (RGB triplets) so the whole palette flips with the OS theme
      // (FR-9.3) while keeping Tailwind's opacity modifiers such as bg-panel-alt/90.
      colors: Object.fromEntries(
        ['panel', 'panel-alt', 'panel-hover', 'stroke', 'bubble', 'bubble-out', 'accent',
          'text-primary', 'text-secondary', 'chat-bg'].map((name) => [name, `rgb(var(--c-${name}) / <alpha-value>)`]),
      ),
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', '-apple-system', 'Helvetica Neue', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
