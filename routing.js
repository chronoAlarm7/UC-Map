// UC campus walking directions.
// Uses Leaflet for the map, the Overpass API for building names,
// and the OSRM foot-routing service for walking routes.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CAMPUS_CENTER = [39.1325, -84.5155];
const INITIAL_ZOOM = 16;
const MIN_ZOOM = 15; // the furthest you can zoom out

// The map can't be panned outside these bounds.
const CAMPUS_BOUNDS = L.latLngBounds([39.115, -84.540], [39.150, -84.490]);

// Area searched for buildings: (south, west, north, east).
const BUILDING_SEARCH_BOX = "(39.125,-84.525,39.139,-84.503)";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const ROUTING_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const COLORS = {
  route: "#e00122",
  start: "#1a9d4a",
  end: "#e00122",
};

// Steps shorter than this (in metres) are hidden from the directions list.
const MIN_STEP_DISTANCE = 3;

// Fallback landmarks, used only if the OpenStreetMap building lookup fails.
const FALLBACK_PLACES = new Map([
  ["Nippert Stadium", [39.1312, -84.5162]],
  ["Langsam Library", [39.1350, -84.5152]],
  ["Tangeman University Center", [39.1331, -84.5152]],
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Place name -> [lat, lng]
let places = FALLBACK_PLACES;

// Points that aren't named places: map-click pins and "My location".
// Each is { name, latLng } or null.
const customPoints = { from: null, to: null };

// Which field the next map click fills in.
let nextPinField = "from";

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = L.map("map", {
  minZoom: MIN_ZOOM,
  maxBounds: CAMPUS_BOUNDS,
  maxBoundsViscosity: 1,
}).setView(CAMPUS_CENTER, INITIAL_ZOOM);

L.tileLayer(TILE_URL, {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Holds the current route line and its start/end markers.
const routeLayer = L.featureGroup().addTo(map);

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showMessage(text) {
  $("message").textContent = text || "";
}

function setStatus(text) {
  $("status").textContent = text;
}

// Refresh the autocomplete suggestions for the From/To inputs.
function updatePlaceSuggestions() {
  const list = $("place-list");
  list.textContent = "";

  const names = [...places.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    list.appendChild(option);
  }
}

function createMarker(latLng, color, label) {
  return L.circleMarker(latLng, {
    radius: 8,
    color: "#fff",
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  }).bindTooltip(label);
}

// ---------------------------------------------------------------------------
// Loading campus buildings
// ---------------------------------------------------------------------------

function buildOverpassQuery(box) {
  return `[out:json][timeout:25];(
    nwr["name"]["building"]${box};
    nwr["name"]["amenity"~"library|cafe|restaurant|fast_food"]${box};
    nwr["name"]["leisure"~"stadium|sports_centre"]${box};
  );out center tags;`;
}

// Nodes have their own coordinates; ways and relations have a computed center.
function getElementLatLng(element) {
  if (element.type === "node") return [element.lat, element.lon];
  if (element.center) return [element.center.lat, element.center.lon];
  return null;
}

async function loadCampusBuildings() {
  try {
    const query = buildOverpassQuery(BUILDING_SEARCH_BOX);
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
    const data = await response.json();

    const found = new Map();
    for (const element of data.elements) {
      const name = element.tags && element.tags.name;
      const latLng = getElementLatLng(element);
      if (name && latLng && !found.has(name)) found.set(name, latLng);
    }

    if (found.size) {
      places = found;
      updatePlaceSuggestions();
      setStatus(`${found.size} places loaded from OpenStreetMap.`);
    } else {
      setStatus("No buildings returned; using a short fallback list.");
    }
  } catch (error) {
    setStatus(
      "Couldn’t load the building list; using a short fallback list. " +
        "You can still drop pins on the map."
    );
  }
}

// ---------------------------------------------------------------------------
// Resolving what the user typed into a point
// ---------------------------------------------------------------------------

// Returns { name, latLng } for the "from" or "to" input, or null if unknown.
// Tries a custom pin first, then an exact name match, then a partial match.
function resolvePoint(field) {
  const text = $(field).value.trim();
  if (!text) return null;

  const custom = customPoints[field];
  if (custom && custom.name === text) return custom;

  const search = text.toLowerCase();
  for (const [name, latLng] of places) {
    if (name.toLowerCase() === search) return { name, latLng };
  }
  for (const [name, latLng] of places) {
    if (name.toLowerCase().includes(search)) return { name, latLng };
  }
  return null;
}

function bothPointsChosen() {
  return resolvePoint("from") && resolvePoint("to");
}

// ---------------------------------------------------------------------------
// Turn-by-turn directions
// ---------------------------------------------------------------------------

// Turn an OSRM route step into a human-readable instruction.
function describeStep(step) {
  const { type, modifier = "" } = step.maneuver;
  const street = step.name;
  const onto = street ? ` onto ${street}` : "";
  const on = street ? ` on ${street}` : "";

  if (type === "depart") return "Start" + on;
  if (type === "arrive") return "Arrive at your destination";
  if (type === "roundabout" || type === "rotary") return "Take the roundabout" + onto;

  const goingStraight =
    !modifier || modifier === "straight" || type === "continue" || type === "new name";
  if (goingStraight) return "Continue" + on;

  // "slight left" -> "Bear left", "left" -> "Turn left"
  if (modifier.startsWith("slight ")) {
    return "Bear " + modifier.slice("slight ".length) + onto;
  }
  return "Turn " + modifier + onto;
}

function showDirections(route) {
  const minutes = Math.max(1, Math.round(route.duration / 60));
  $("summary").textContent = `${Math.round(route.distance)} m · about ${minutes} min walk`;

  const list = $("steps");
  list.textContent = "";

  const steps = route.legs[0].steps.filter(
    (step) => step.distance >= MIN_STEP_DISTANCE || step.maneuver.type === "arrive"
  );

  for (const step of steps) {
    const item = document.createElement("li");
    item.textContent = describeStep(step);

    if (step.distance >= MIN_STEP_DISTANCE) {
      const distance = document.createElement("small");
      distance.textContent = ` · ${Math.round(step.distance)} m`;
      item.appendChild(distance);
    }
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function fetchWalkingRoute(start, end) {
  // OSRM expects coordinates as lng,lat
  const coords = `${start.latLng[1]},${start.latLng[0]};${end.latLng[1]},${end.latLng[0]}`;
  const url = `${ROUTING_URL}/${coords}?overview=full&geometries=geojson&steps=true`;

  const response = await fetch(url);
  const data = await response.json();
  if (data.code !== "Ok") throw new Error(data.code || "no route");
  return data.routes[0];
}

function drawRoute(route, start, end) {
  routeLayer.clearLayers();
  L.geoJSON(route.geometry, {
    style: { color: COLORS.route, weight: 6, opacity: 0.9 },
  }).addTo(routeLayer);
  createMarker(start.latLng, COLORS.start, start.name).addTo(routeLayer);
  createMarker(end.latLng, COLORS.end, end.name).addTo(routeLayer);
  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

async function getDirections() {
  showMessage("");

  const start = resolvePoint("from");
  const end = resolvePoint("to");
  if (!start || !end) {
    showMessage("Choose a start and a destination from the suggestions, or click the map.");
    return;
  }

  try {
    const route = await fetchWalkingRoute(start, end);
    drawRoute(route, start, end);
    showDirections(route);
  } catch (error) {
    showMessage(`Couldn’t get a walking route (${error.message}). Try again in a moment.`);
  }
}

function getDirectionsIfReady() {
  if (bothPointsChosen()) getDirections();
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function swapStartAndEnd() {
  const fromInput = $("from");
  const toInput = $("to");
  [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
  [customPoints.from, customPoints.to] = [customPoints.to, customPoints.from];
  getDirectionsIfReady();
}

// Clicking the map alternates between dropping a start pin and an end pin.
function dropPin(event) {
  const field = nextPinField;
  const name = field === "from" ? "Start pin" : "End pin";

  customPoints[field] = { name, latLng: [event.latlng.lat, event.latlng.lng] };
  $(field).value = name;

  nextPinField = field === "from" ? "to" : "from";
  getDirectionsIfReady();
}

function useMyLocation() {
  if (!navigator.geolocation) {
    showMessage("Location isn’t available in this browser.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const name = "My location";
      customPoints.from = {
        name,
        latLng: [position.coords.latitude, position.coords.longitude],
      };
      $("from").value = name;
      nextPinField = "to";
      getDirectionsIfReady();
    },
    () => showMessage("Couldn’t get your location (permission denied?).")
  );
}

$("get-directions").addEventListener("click", getDirections);
$("swap").addEventListener("click", swapStartAndEnd);
$("use-location").addEventListener("click", useMyLocation);
$("from").addEventListener("change", getDirectionsIfReady);
$("to").addEventListener("change", getDirectionsIfReady);
map.on("click", dropPin);

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

updatePlaceSuggestions();
loadCampusBuildings();
