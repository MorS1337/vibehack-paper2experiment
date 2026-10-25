import { createContext } from "react";

export interface PaperNavigation {
  cite: (page: number, quote?: string) => void;
}

export const PaperContext = createContext<PaperNavigation | null>(null);
