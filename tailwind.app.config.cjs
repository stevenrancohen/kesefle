/**
 * Static Tailwind build for the canonical /app PWA shell.
 *
 * Keep this palette in lock-step with the former inline CDN configuration.
 * The generated css/app-tailwind.css is committed so Vercel and the service
 * worker never need a runtime compiler or a third-party CDN to render /app.
 */
module.exports = {
  content: ['./app.html'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Heebo', 'system-ui', 'sans-serif'],
        display: ['Rubik', 'Heebo', 'sans-serif'],
      },
      colors: {
        ink: {
          50: '#f7f7f5',
          100: '#ececea',
          200: '#d7d8d5',
          300: '#b4b6b4',
          400: '#8c9093',
          500: '#696e73',
          600: '#50555b',
          700: '#363a40',
          800: '#202329',
          900: '#14161b',
          950: '#090a0d',
        },
        brand: {
          50: '#fffbea',
          100: '#fff3c4',
          200: '#ffe676',
          300: '#fddd48',
          400: '#f8cb23',
          500: '#e7b20a',
          600: '#b98700',
          700: '#8a6200',
          800: '#5c4100',
          900: '#3d2b00',
        },
        accent: {
          400: '#5b86ff',
          500: '#3f6ff5',
          600: '#2b56d9',
        },
      },
    },
  },
};
