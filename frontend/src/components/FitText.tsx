import { useEffect, useLayoutEffect, useRef, useState } from "react";

/*
 * One line of text that shrinks its font to fit its box instead of
 * overflowing or pushing its neighbours. Meant for live readouts that update
 * many times a second, so it only measures when the text's length or the
 * box's width changes (with tabular digits, the width follows the length).
 * It shrinks at once but grows back only after the text has fit the larger
 * size for GROW_DELAY_MS, so a value flickering between 4 and 5 characters
 * (a sign coming and going) does not make the size jump with it.
 */

const GROW_DELAY_MS = 2000;
const MIN_SCALE = 0.55;

export function FitText({ text, className }: { text: string; className?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);
  const [boxWidth, setBoxWidth] = useState(0);
  const growTimer = useRef<number | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (growTimer.current !== null) window.clearTimeout(growTimer.current);
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = textRef.current;
    if (!box || !inner || !boxWidth) return;
    // Width scales linearly with the font size, so the size that fits
    // follows from one measurement at the current size.
    const width = inner.offsetWidth;
    if (!width) return;
    const fit = Math.max(MIN_SCALE, Math.min(1, (scale * boxWidth) / width));
    if (fit < scale - 0.001) {
      if (growTimer.current !== null) {
        window.clearTimeout(growTimer.current);
        growTimer.current = null;
      }
      setScale(fit);
    } else if (fit > scale + 0.001 && growTimer.current === null) {
      growTimer.current = window.setTimeout(() => {
        growTimer.current = null;
        setScale(fit);
      }, GROW_DELAY_MS);
    } else if (fit <= scale + 0.001 && growTimer.current !== null) {
      window.clearTimeout(growTimer.current);
      growTimer.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text.length, boxWidth, scale]);

  return (
    <span ref={boxRef} className={`fit-text${className ? ` ${className}` : ""}`}>
      <span ref={textRef} style={scale < 1 ? { fontSize: `${scale}em` } : undefined}>
        {text}
      </span>
    </span>
  );
}
