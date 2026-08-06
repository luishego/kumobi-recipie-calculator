/** @type {import('tailwindcss').Config} */
// Tokens semánticos del sistema de diseño (fase 02). Re-tematizables para la marca
// Kumobi sin tocar componentes: basta cambiar los valores `primary`.
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
  theme: {
    extend: {
      colors: {
        // Neutros base del panel (escala slate)
        'app': '#F8FAFC',
        'surface': '#FFFFFF',
        'border-base': '#E2E8F0',
        'text-strong': '#0F172A',
        'text-base': '#334155',
        'text-muted': '#64748B',
        // Primario (marca provisional — sustituible)
        primary: {
          DEFAULT: '#4F46E5',
          hover: '#4338CA',
          soft: '#EEF2FF',
        },
        // Semáforo de Food Cost (dedicado; no reusar con estados de sistema)
        fc: {
          'good-text': '#15803D',
          'good-bg': '#DCFCE7',
          'good-dot': '#22C55E',
          'warn-text': '#B45309',
          'warn-bg': '#FEF3C7',
          'warn-dot': '#F59E0B',
          'bad-text': '#B91C1C',
          'bad-bg': '#FEE2E2',
          'bad-dot': '#EF4444',
        },
        // Estados de sistema / alertas
        success: '#16A34A',
        warning: '#D97706',
        danger: '#DC2626',
        info: '#0284C7',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      },
      fontSize: {
        // Base 14px (densidad de dashboard)
        xs: ['12px', '16px'],
        sm: ['14px', '20px'],
        base: ['16px', '24px'],
        lg: ['18px', '26px'],
        xl: ['20px', '28px'],
        '2xl': ['24px', '32px'],
        '3xl': ['30px', '38px'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.06)',
      },
      maxWidth: {
        '7xl': '80rem',
      },
    },
  },
  plugins: [],
};
