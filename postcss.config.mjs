// Tailwind v4 emits its own vendor prefixes, so there is no autoprefixer pass.
const config = {
  plugins: {
    "@tailwindcss/postcss": {}
  }
};

export default config;
