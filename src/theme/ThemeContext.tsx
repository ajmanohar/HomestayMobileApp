import React, { createContext, useContext, useState, useMemo } from 'react';
import { useColorScheme } from 'react-native';

/**
 * Interface defining the exact color tokens for the Homestay app.
 * Adheres to Facebook-style high-contrast whitespace and OLED dark mode.
 */
export interface ColorPalette {
  background: string;
  surface: string;
  surfaceSubtle: string;
  border: string;
  textPrimary: string;
  textMuted: string;
  primaryBrand: string;
  accent: string;
  statusPending: string;
  statusProcess: string;
  statusReady: string;
  statusDone: string;
}

/**
 * Light Theme tokens: Clean, soft gray canvas with pure white elevated surfaces.
 */
export const lightPalette: ColorPalette = {
  background: '#F0F2F5',    // Facebook-style soft gray backdrop
  surface: '#FFFFFF',       // Pure white card surface
  surfaceSubtle: '#F8FAFC', // Subtle inner field fills
  border: '#E4E6EB',        // Hairline card borders
  textPrimary: '#050505',   // High-contrast primary text
  textMuted: '#65676B',     // Secondary metadata text
  primaryBrand: '#0D474A',  // Kochi Deep Teal
  accent: '#D97724',        // Warm Ochre for capture actions
  statusPending: '#D97706', // Amber for UPLOAD_PENDING
  statusProcess: '#2563EB', // Blue for PROCESSING
  statusReady: '#059669',   // Emerald green for PENDING_REVIEW
  statusDone: '#4F46E5',    // Indigo for REVIEWED
};

/**
 * Dark Theme tokens: Low-eyestrain dark navy with elevated surface cards.
 */
export const darkPalette: ColorPalette = {
  background: '#0F172A',    // Deep slate background
  surface: '#1E293B',       // Elevated navy card
  surfaceSubtle: '#334155', // Input fields background
  border: '#334155',        // Soft divider border
  textPrimary: '#F8FAFC',   // High-contrast near-white text
  textMuted: '#94A3B8',     // Muted slate text
  primaryBrand: '#14B8A6',  // Luminous teal for dark mode
  accent: '#F59E0B',        // Vibrant amber for dark mode
  statusPending: '#FBBF24', // Lighter amber for visibility
  statusProcess: '#60A5FA', // Lighter cobalt blue
  statusReady: '#34D399',   // Lighter emerald green
  statusDone: '#818CF8',    // Lighter indigo
};

/**
 * Context state contract providing active colors, dark mode flag, and toggle function.
 */
interface ThemeContextType {
  isDark: boolean;
  colors: ColorPalette;
  toggleTheme: () => void;
}

// Initialize Context with undefined default
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * ThemeProvider wraps the application root to make theme tokens and
 * the top-bar toggle function globally accessible across all screens.
 *
 * @param children - Root or nested React Native component hierarchy
 */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Query system color scheme as the initial fallback default
  const systemScheme = useColorScheme();
  
  // State tracking user's explicit theme preference
  const [isDark, setIsDark] = useState<boolean>(systemScheme === 'dark');

  // Callback handler to alternate between light and dark
  const toggleTheme = () => {
    setIsDark((prev) => !prev);
  };

  // Memoize active color set to prevent unnecessary child rerenders
  const colors = useMemo(() => (isDark ? darkPalette : lightPalette), [isDark]);

  return (
    <ThemeContext.Provider value={{ isDark, colors, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

/**
 * Custom hook to consume the active theme colors and toggle action.
 * Ensures the component consuming the hook is enclosed inside ThemeProvider.
 */
export const useAppTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useAppTheme must be used within a ThemeProvider');
  }
  return context;
};