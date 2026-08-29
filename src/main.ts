import { Game } from "./core/Game";
import { installLoadingScreen, reportBootFailure } from "./core/loadingScreen";
import { LightingSystem } from "./systems/LightingSystem";
import { TerrainSystem } from "./systems/TerrainSystem";
import { PlayerSystem } from "./systems/PlayerSystem";
import { PumpSystem } from "./systems/PumpSystem";
import { CarSystem } from "./systems/CarSystem";
import { BuildingSystem } from "./systems/BuildingSystem";
import { AudioSystem } from "./systems/AudioSystem";
import { InteractionSystem } from "./systems/InteractionSystem";
import { VegetationSystem } from "./systems/VegetationSystem";
import { CanopySystem } from "./systems/CanopySystem";

/**
 * Systems initialise in registration order. Later systems (canopy, pumps,
 * building, signage, vegetation, wetness, interaction, audio, post) get
 * appended here and pull whatever they need out of the service registry
 * (`groundHeight`, `sunDirection`, `sunLight`, ...).
 */
// Before the Game, so the overlay is already listening when `start()` announces
// its system list. It only adopts the markup index.html already painted.
installLoadingScreen();

const game = new Game();

game.register(new LightingSystem(), new TerrainSystem(), new PumpSystem(), new CarSystem(), new PlayerSystem(), new BuildingSystem());

// The canopy needs nothing but the site plan, and publishes `canopy.blockers`,
// which PlayerSystem collects on its first frame regardless of order.
game.register(new CanopySystem());

// Vegetation after the building: it reads `groundHeight`, `sunDirection` and
// the building footprint so nothing is planted through a wall.
game.register(new VegetationSystem());

// Audio last: it reads the building's footprint, door and fixtures.
game.register(new AudioSystem());

// Interaction last of all: it drives handles published by the pumps, the
// building, audio and lighting, and updates after the player has moved.
game.register(new InteractionSystem());

game.start().catch((err) => {
  console.error(err);
  reportBootFailure(err);
});
