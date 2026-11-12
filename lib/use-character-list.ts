"use client";

import { useEffect, useState } from "react";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "./character-storage";

export function useCharacterList() {
  const [characters, setCharacters] = useState(loadCharacters);
  useEffect(() => {
    const refresh = () => setCharacters(loadCharacters());
    refresh();
    window.addEventListener(CHARACTERS_UPDATED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(CHARACTERS_UPDATED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return characters;
}
