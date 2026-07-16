import type { App } from "obsidian";
import { CampaignConfigSchema, slugify } from "../model/campaignConfig";
import type { CampaignConfig } from "../model/campaignConfig";
import type { TerrainBlock } from "../view/terrainSettings";

/** The default fictional world box ([minX, minY, maxX, maxY] in fake lng/lat).
 * Shared by the creation modal and the headless twin so both scaffold the same
 * bounded world; resized later by editing `bounds` in the note frontmatter. */
export const DEFAULT_FICTIONAL_BOUNDS: [number, number, number, number] = [-8, -6, 8, 6];

export interface NewCampaignInput {
  name: string;
  crs: CampaignConfig["crs"];
  theme: CampaignConfig["theme"];
  seed: number;
  scaleMetersPerUnit: number;
  // fictional only — real campaigns get bounds from their basemap instead
  bounds?: [number, number, number, number];
  // optional campaign base-terrain block (plan 036-D). Omit for an inert
  // flat base; present (any non-default field) turns the continental base on.
  terrain?: TerrainBlock;
}

export interface NewCampaignResult {
  path: string;
  campaignFolder: string;
}

/** Assemble the frontmatter object exactly as it will be persisted, so it can
 * be validated by the same zod schema the loader uses (`parseCampaignConfig`)
 * BEFORE anything touches disk. Keeps write-time frontmatter and read-time
 * validation from ever drifting. */
function buildFrontmatter(input: NewCampaignInput): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    "map-campaign": true,
    crs: input.crs,
    theme: input.theme,
    seed: input.seed,
    scaleMetersPerUnit: input.scaleMetersPerUnit,
  };
  if (input.crs === "fictional" && input.bounds) fm.bounds = input.bounds;
  if (input.terrain) fm.terrain = input.terrain;
  return fm;
}

/** Serialize the validated frontmatter object to YAML lines. Kept hand-rolled
 * (not a YAML lib) to match the existing minimal-frontmatter house style and
 * the shape real campaigns like Vailmarch persist. */
function frontmatterLines(fm: Record<string, unknown>, name: string): string[] {
  const lines = [
    "---",
    "map-campaign: true",
    `crs: ${fm.crs}`,
    `theme: ${fm.theme}`,
    `seed: ${fm.seed}`,
    `scaleMetersPerUnit: ${fm.scaleMetersPerUnit}`,
  ];
  const bounds = fm.bounds as [number, number, number, number] | undefined;
  if (bounds) lines.push(`bounds: [${bounds.join(", ")}]`);
  const terrain = fm.terrain as TerrainBlock | undefined;
  if (terrain) {
    lines.push("terrain:");
    lines.push(`  campAmp: ${terrain.campAmp}`);
    lines.push(`  seaDatum: ${terrain.seaDatum}`);
    // grade defaults false; only persist when on (minimal-frontmatter house style)
    if (terrain.grade) lines.push(`  grade: true`);
  }
  lines.push("---", "", `${name} — campaign map.`, "");
  return lines;
}

/** Vault layout matches ARCHITECTURE.md exactly: <folder>/<Name>.map.md, Locations/,
 * Sessions/ (organizational only, never read by code — see ARCHITECTURE.md).
 * Fabric.geojson and Generated.json are created lazily on first write (their
 * stores return empty defaults when absent), so they are intentionally NOT
 * scaffolded here. Frontmatter is validated against CampaignConfigSchema before
 * any write — a bad campaign never reaches disk. */
export async function createCampaignNote(app: App, input: NewCampaignInput): Promise<NewCampaignResult> {
  const name = input.name.trim();
  if (!name) throw new Error("Campaign name is required");

  const fm = buildFrontmatter({ ...input, name });
  const parsed = CampaignConfigSchema.safeParse(fm);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid campaign config: ${issues.join("; ")}`);
  }

  const campaignFolder = `Campaigns/${name}`;
  if (await app.vault.adapter.exists(campaignFolder)) {
    throw new Error(`"${campaignFolder}" already exists`);
  }

  await app.vault.createFolder(campaignFolder);
  await app.vault.createFolder(`${campaignFolder}/Locations`);
  await app.vault.createFolder(`${campaignFolder}/Sessions`);

  const path = `${campaignFolder}/${name}.map.md`;
  await app.vault.create(path, frontmatterLines(fm, name).join("\n"));

  return { path, campaignFolder };
}

/**
 * Options for the headless creation twin. Every field the creation modal
 * collects has a default here, so a test can create a valid campaign with just
 * a name — while still exercising the real `createCampaignNote` path (folder
 * scaffold + zod-validated frontmatter) that the modal uses.
 */
export interface CreateCampaignOpts {
  name: string;
  crs?: CampaignConfig["crs"];
  theme?: CampaignConfig["theme"];
  seed?: number;
  scaleMetersPerUnit?: number;
  bounds?: [number, number, number, number];
  terrain?: TerrainBlock;
}

/**
 * Headless test-API twin of `CreateCampaignModal` (CLAUDE law: every modal flow
 * needs a headless twin — modals hang CLI). Applies the same defaults the modal
 * seeds, then runs the identical on-disk creation path. Drive it from tests or
 * the live test API instead of the modal.
 */
export async function createCampaignForTest(app: App, opts: CreateCampaignOpts): Promise<NewCampaignResult> {
  const crs = opts.crs ?? "fictional";
  return createCampaignNote(app, {
    name: opts.name,
    crs,
    theme: opts.theme ?? "obsidian-native",
    seed: opts.seed ?? Math.floor(Math.random() * 1_000_000),
    scaleMetersPerUnit: opts.scaleMetersPerUnit ?? 1,
    bounds: crs === "fictional" ? opts.bounds ?? DEFAULT_FICTIONAL_BOUNDS : undefined,
    terrain: opts.terrain,
  });
}

export { slugify };
