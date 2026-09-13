// Load HWN stamp data from local JSON
export async function loadStamps() {
    const response = await fetch("./data/stampingpoints.json");
    if (!response.ok) {
        throw new Error("Konnte Stempeldaten nicht laden");
    }
    return response.json();
}
