/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./static/index.html', './static/login.html', './static/**/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Pretendard', 'system-ui', 'sans-serif'] },
      colors: {
        base: '#0f0f0f',
        surface: 'rgba(255,255,255,0.03)',
        accent: { DEFAULT: '#34d399', dim: 'rgba(52,211,153,0.15)', glow: 'rgba(52,211,153,0.25)' },
      },
      borderRadius: { bezel: '1.25rem', 'bezel-inner': 'calc(1.25rem - 0.375rem)' },
    },
  },
  plugins: [],
};
