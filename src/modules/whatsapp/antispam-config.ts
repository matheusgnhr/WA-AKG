export const antiSpamDefaults = { spamLimit: 5, spamInterval: 10, spamDelayMin: 1000, spamDelayMax: 3000 };

/** Validate the merged configuration so partial updates cannot invert the delay bounds. */
export function validAntiSpamConfig(config: Record<string, unknown>): boolean {
    const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    return integer(config.spamLimit, 1, 10000)
        && integer(config.spamInterval, 1, 3600)
        && integer(config.spamDelayMin, 1, 60000)
        && integer(config.spamDelayMax, 1, 60000)
        && Number(config.spamDelayMax) >= Number(config.spamDelayMin);
}
