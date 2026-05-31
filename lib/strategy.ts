function isEarlySignal(adx: number, stochK: number) {
  // BEFORE: too strict (rare signals)
  // NOW: allow real market compression detection

  return (
    adx > 10 && adx < 45 && (
      stochK < 65 && stochK > 35
    )
  );
}

function isSniperEntry(structure: string, stochK: number) {
  // loosen breakout trigger so moves actually register early

  const breakoutUp =
    structure === "Bullish" && stochK > 55;

  const breakoutDown =
    structure === "Bearish" && stochK < 45;

  return breakoutUp || breakoutDown;
}
