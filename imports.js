const dateien = [
    "____by_assims/script.js",
    "____by_assims/vm/libv86.js"
];

dateien.forEach(async (datei) => {
    try {
        await import(`./${datei}`);
    } catch (error) {
        console.error('Fehler beim Importieren der Datei:', datei, error+error.stack);
    }
});