import { getUniverseSnapshot } from "../lib/queries";
import { getSignalHorizons } from "../lib/horizons";
import { HomeClient } from "./home-client";

export default function HomePage() {
  // Show all tracked tokens; decision columns may be empty when no recent submit exists.
  const universe = getUniverseSnapshot(200);
  const horizons = getSignalHorizons();

  return <HomeClient initialUniverse={universe} horizons={horizons} />;
}
