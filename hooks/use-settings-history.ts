"use client";

import { useCallback, useReducer } from "react";
import type { SetStateAction } from "react";

type History<T> = { past: T[]; present: T; future: T[]; group?: string; time: number };
type Action<T> = { type: "set" | "reset"; value: SetStateAction<T>; group?: string; time: number } | { type: "undo" } | { type: "redo" };
const LIMIT = 60;

function reducer<T>(state: History<T>, action: Action<T>): History<T> {
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous === undefined ? state : {
      past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future].slice(0, LIMIT), time: 0,
    };
  }
  if (action.type === "redo") {
    const next = state.future[0];
    return next === undefined ? state : {
      past: [...state.past, state.present].slice(-LIMIT), present: next, future: state.future.slice(1), time: 0,
    };
  }
  const value = typeof action.value === "function" ? (action.value as (current: T) => T)(state.present) : action.value;
  if (action.type === "reset") return { past: [], present: value, future: [], time: 0 };
  if (JSON.stringify(value) === JSON.stringify(state.present)) return state;
  // Consecutive changes to one slider form a single undo step. Applying a
  // preset, resetting a section, or changing another control starts a new step.
  const merge = action.group !== undefined && action.group === state.group && action.time - state.time < 600 && !state.future.length;
  return {
    past: merge ? state.past : [...state.past, state.present].slice(-LIMIT), present: value, future: [], group: action.group, time: action.time,
  };
}

export function useSettingsHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(reducer<T>, { past: [], present: initial, future: [], time: 0 });
  const setValue = useCallback((value: SetStateAction<T>, group?: string) => dispatch({ type: "set", value, group, time: Date.now() }), []);
  const resetValue = useCallback((value: SetStateAction<T>) => dispatch({ type: "reset", value, time: 0 }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  return { value: state.present, setValue, resetValue, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
