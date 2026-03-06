/** @type {import('tailwindcss').Config} */
module.exports = {
    // NOTE: Update this to include the paths to all of your component files.
    content: ['./app/**/*.{js,ts,tsx}', './components/**/*.{js,ts,tsx}'],
    presets: [require("nativewind/preset")],
    theme: {
      extend: {
        fontFamily: {
          sans: ['Inter', 'Inter-Regular', 'sans-serif'],
        },
      },
    },
    plugins: [],
  }