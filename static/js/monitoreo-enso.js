// --- SILENCIADOR DE WARNINGS NATIVOS ---
const originalWarn = console.warn;
console.warn = function(...args) {
    const msg = args.join(' ');
    if (msg.includes('Synchronous XMLHttpRequest') || msg.includes('stream HTTP requests') || msg.includes('Source map error')) return;
    originalWarn.apply(console, args);
};

const csvFileName = 'data/Indices_ENSO.csv';
let pyodide;
let trazoContinentes = null;

async function cargarGeometriasMundo() {
    try {
        const res = await fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json');
        const data = await res.json();
        let lon = [], lat = [];
        data.features.forEach(feature => {
            const geom = feature.geometry;
            if (!geom) return;
            if (geom.type === 'Polygon') {
                geom.coordinates.forEach(ring => {
                    ring.forEach(pt => { lon.push(pt[0]); lat.push(pt[1]); });
                    lon.push(null); lat.push(null);
                });
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(poly => {
                    poly.forEach(ring => {
                        ring.forEach(pt => { lon.push(pt[0]); lat.push(pt[1]); });
                        lon.push(null); lat.push(null);
                    });
                });
            }
        });
        trazoContinentes = { x: lon, y: lat, type: 'scatter', mode: 'lines', line: { color: '#0f172a', width: 1.2 }, hoverinfo: 'skip', showlegend: false };
    } catch (error) {
        console.warn("Geometría de mapa no cargada:", error);
    }
}

async function main() {
    const loadingText = document.getElementById("loading-text");

    try {
        const promesaContinentes = cargarGeometriasMundo();

        loadingText.innerText = "Cargando ecosistema Científico...";
        pyodide = await loadPyodide();
        await pyodide.loadPackage(["pandas", "numpy", "xarray", "zarr", "fsspec", "numcodecs", "cftime", "requests"]);

        loadingText.innerText = "Abriendo Datasets y consolidando variables...";
        const response = await fetch(csvFileName);
        if (!response.ok) throw new Error("No se encontró el archivo CSV local.");
        const csvText = await response.text();

        pyodide.globals.set("csv_content", csvText);

        await pyodide.runPythonAsync(`
          import pandas as pd
          import numpy as np
          import xarray as xr
          import requests
          import json
          import zarr
          import io
          from collections.abc import MutableMapping
          from js import window

          # --- PROCESAR CSV ---
          df = pd.read_csv(io.StringIO(csv_content))
          df['date'] = pd.to_datetime(df['date'])
          df = df.set_index('date')
          columnas_csv = list(df.columns)

          min_year_csv = int(df.index.year.min())
          max_year_csv = int(df.index.year.max())

          # --- PROCESAR ZARR DINÁMICO ---
          base_url = window.location.href.split('?')[0].split('#')[0].rsplit('/', 1)[0]
          zarr_url = f"{base_url}/data/anomaly_maps.zarr"

          # Lector HTTP simplificado (Ya no necesitamos hardcodear rutas gracias a consolidated=True)
          class BrowserHTTPStore(MutableMapping):
              def __init__(self, url):
                  self.url = url.rstrip('/')
                  self.session = requests.Session()
                  self.session.headers.clear()

              def __getitem__(self, key):
                  res = self.session.get(f"{self.url}/{key}")
                  if res.status_code == 200: return res.content
                  raise KeyError(key)

              def __setitem__(self, key, value): pass
              def __delitem__(self, key): pass
              def __iter__(self): return iter([])
              def __len__(self): return 0
              def __contains__(self, key): return self.session.head(f"{self.url}/{key}").status_code == 200

          # Abrimos Zarr globalmente con CONSOLIDATED=TRUE
          raw_store = BrowserHTTPStore(zarr_url)
          store = zarr.storage.KVStore(raw_store)
          ds_zarr = xr.open_zarr(store, consolidated=True)

          # Detectar mágicamente las variables espaciales (excluyendo lat, lon, time, etc.)
          variables_zarr = list(ds_zarr.data_vars.keys())

          zarr_min_date = pd.to_datetime(ds_zarr.time.values.min())
          zarr_max_date = pd.to_datetime(ds_zarr.time.values.max())
          zarr_min_year = int(zarr_min_date.year)
          zarr_max_year = int(zarr_max_date.year)
          zarr_min_month = int(zarr_min_date.month)
          zarr_max_month = int(zarr_max_date.month)
        `);

        // POBLAR MENU CSV
        const colCSV = pyodide.globals.get("columnas_csv").toJs();
        const selectCSV = document.getElementById("indicesSelect");
        colCSV.forEach((col, index) => {
            const option = document.createElement("option");
            option.text = col.replace(/_/g, ' ');
            option.value = col;
            if (index === 0 || ['ONI', 'ICEN'].includes(col)) option.selected = true; // Dinámico
            selectCSV.add(option);
        });

        // POBLAR NUEVO MENU ZARR
        const varZarr = pyodide.globals.get("variables_zarr").toJs();
        const selectZarr = document.getElementById("varZarrSelect");
        varZarr.forEach((v, index) => {
            const option = document.createElement("option");
            option.text = v.toUpperCase();
            option.value = v;
            if (index === 0) option.selected = true;
            selectZarr.add(option);
        });

        // RESTRICCIONES DE TIEMPO
        const minYearCSV = pyodide.globals.get("min_year_csv");
        const maxYearCSV = pyodide.globals.get("max_year_csv");
        document.getElementById("yearStart").min = minYearCSV;
        document.getElementById("yearStart").max = maxYearCSV;
        document.getElementById("yearEnd").min = minYearCSV;
        document.getElementById("yearEnd").max = maxYearCSV;

        const zarrMinYear = pyodide.globals.get("zarr_min_year");
        const zarrMaxYear = pyodide.globals.get("zarr_max_year");
        const zarrMinMonth = pyodide.globals.get("zarr_min_month");
        const zarrMaxMonth = pyodide.globals.get("zarr_max_month");

        const mapYearInput = document.getElementById("mapYear");
        const mapMonthInput = document.getElementById("mapMonth");
        mapYearInput.min = zarrMinYear;
        mapYearInput.max = zarrMaxYear;

        mapYearInput.addEventListener('change', (e) => {
            let y = parseInt(e.target.value);
            if (y < zarrMinYear) { y = zarrMinYear; mapYearInput.value = y; }
            if (y > zarrMaxYear) { y = zarrMaxYear; mapYearInput.value = y; }

            mapMonthInput.min = (y === zarrMinYear) ? zarrMinMonth : 1;
            mapMonthInput.max = (y === zarrMaxYear) ? zarrMaxMonth : 12;

            let m = parseInt(mapMonthInput.value);
            if (m < mapMonthInput.min) mapMonthInput.value = mapMonthInput.min;
            if (m > mapMonthInput.max) mapMonthInput.value = mapMonthInput.max;
        });
        mapYearInput.dispatchEvent(new Event('change'));

        await promesaContinentes;
        document.getElementById("loader-overlay").style.display = "none";
        document.getElementById("main-controls").style.opacity = "1";
        document.getElementById("main-controls").style.pointerEvents = "auto";

        generarGrafico();
        generarMapa();

    } catch (error) {
        console.error(error);
        loadingText.innerHTML = `<span style="color: red;">Error: ${error.message}</span>`;
    }
}

async function generarGrafico() {
    const yStart = parseInt(document.getElementById("yearStart").value);
    const yEnd = parseInt(document.getElementById("yearEnd").value);
    const select = document.getElementById("indicesSelect");
    const selectedIndices = Array.from(select.selectedOptions).map(opt => opt.value);

    if (selectedIndices.length === 0) return;

    pyodide.globals.set("selected_cols", selectedIndices);
    pyodide.globals.set("yStart", yStart);
    pyodide.globals.set("yEnd", yEnd);

    const tracesJson = await pyodide.runPythonAsync(`
      mask = (df.index.year >= yStart) & (df.index.year <= yEnd)
      df_filtered = df.loc[mask]

      traces = []
      for col in selected_cols:
          valores_limpios = [None if pd.isna(x) else x for x in df_filtered[col].tolist()]
          traces.append({
              'x': df_filtered.index.strftime('%Y-%m-%d').tolist(),
              'y': valores_limpios,
              'type': 'scatter',
              'mode': 'lines',
              'name': col.replace('_', ' '),
              'line': {'width': 1.5}
          })

      json.dumps(traces)
     `);

    const plotData = JSON.parse(tracesJson);
    const layout = {
        xaxis: { title: 'Fecha', showgrid: true, gridcolor: '#f1f5f9' },
        yaxis: { title: 'Valor', showgrid: true, gridcolor: '#f1f5f9', zeroline: true, zerolinecolor: '#1e293b' },
        plot_bgcolor: '#ffffff', paper_bgcolor: '#ffffff',
        hovermode: 'x unified',
        margin: { l: 50, r: 20, t: 30, b: 40 }
    };
    Plotly.newPlot('ts-container', plotData, layout, {responsive: true});
 }

 async function generarMapa() {
     const year = parseInt(document.getElementById("mapYear").value);
     const month = parseInt(document.getElementById("mapMonth").value);
     const selectedVar = document.getElementById("varZarrSelect").value;

     pyodide.globals.set("map_year", year);
     pyodide.globals.set("map_month", month);
     pyodide.globals.set("selected_var", selectedVar);

     const mapContainer = document.getElementById("map-container");
     mapContainer.innerHTML = "<div class='spinner' style='margin:auto; display:block; margin-top:100px;'></div>";

     const mapDataJson = await pyodide.runPythonAsync(`
       import json
       import numpy as np
       from js import window

       fecha_str = f"{map_year}-{map_month:02d}-01"

       try:
           # EXTRACCIÓN DINÁMICA
           mapa_mes = ds_zarr[selected_var].sel(time=fecha_str, method='nearest')
           fecha_real = str(mapa_mes.time.values)[:10]

           # Xarray ya decodificó el scale_factor (0.01) automáticamente aquí
           z_vals = mapa_mes.values.astype(float)

           lon_coord = 'lon' if 'lon' in mapa_mes.coords else 'longitude'
           lat_coord = 'lat' if 'lat' in mapa_mes.coords else 'latitude'

           lon_vals = mapa_mes[lon_coord].values.astype(float)
           lat_vals = mapa_mes[lat_coord].values.astype(float)

           z_vals_clean = np.where(np.isnan(z_vals), None, z_vals).tolist()

           # LEER TUS METADATOS PERSONALIZADOS
           unit = ds_zarr[selected_var].attrs.get('units', '')
           long_name = ds_zarr[selected_var].attrs.get('long_name', selected_var.upper())

           result = {
               'z': z_vals_clean,
               'x': lon_vals.tolist(),
               'y': lat_vals.tolist(),
               'fecha_real': fecha_real,
               'var_name': selected_var.upper(),
               'long_name': long_name,
               'unit': unit
           }
       except Exception as e:
           result = {'error': str(e)}

       json.dumps(result)
     `);

     const mapData = JSON.parse(mapDataJson);
     mapContainer.innerHTML = "";

     if (mapData.error) {
         mapContainer.innerHTML = `<p style='color:red; text-align:center; margin-top:100px;'>Error leyendo Zarr: ${mapData.error}</p>`;
         return;
     }

     document.getElementById("map-panel-title").innerText = `Anomalía de ${mapData.var_name}`;

     function formatLon(lon) {
         if (lon === 0) return '0°';
         if (lon === 180 || lon === -180) return '180°';
         return lon < 0 ? Math.abs(lon) + '°W' : lon + '°E';
     }

     function formatLat(lat) {
         if (lat === 0) return '0°';
         return lat < 0 ? Math.abs(lat) + '°S' : lat + '°N';
     }

     const lonTicks = [-180, -160, -140, -120, -100, -80, -60];
     const latTicks = [-30, -20, -10, 0, 10, 20, 30];

     // LÓGICA DE COLORES CLIMATOLÓGICOS
         const isSST = mapData.var_name === 'SST';
         const isPrec = mapData.var_name === 'PREC';

         let colorPalette = 'Viridis';
         if (isSST) colorPalette = 'RdBu';
         if (isPrec) colorPalette = 'BrBG'; // Brown-Green (Seco-Húmedo)

         const hoverText = [];
             for (let i = 0; i < mapData.y.length; i++) {
                 let row = [];
                 let hLat = formatLat(mapData.y[i]); // Ej: 10°S
                 for (let j = 0; j < mapData.x.length; j++) {
                     let hLon = formatLon(mapData.x[j]); // Ej: 120°W
                     let zVal = mapData.z[i][j];
                     let zStr = zVal !== null ? zVal.toFixed(2) : 'N/A'; // Evitamos errores con los continentes
                     row.push(`Lon: ${hLon}<br>Lat: ${hLat}<br>${mapData.var_name}: ${zStr} ${mapData.unit}`);
                 }
                 hoverText.push(row);
             }

         const capaDatos = {
             z: mapData.z,
             x: mapData.x,
             y: mapData.y,
             text: hoverText, // Inyectamos nuestra matriz de texto puro
             type: 'heatmap',
             zsmooth: 'best',
             colorscale: colorPalette,
             reversescale: isSST ? false : true,
             colorbar: { title: mapData.unit },
             hovertemplate: '%{text}<extra></extra>' // Le decimos a Plotly que solo lea nuestra matriz
         };

         if (isSST) {
             capaDatos.zmin = -3;
             capaDatos.zmax = 3;
         }

         const datosMapa = [capaDatos];
         if (trazoContinentes) datosMapa.push(trazoContinentes);

         const layout = {
             title: { text: `${mapData.long_name} (${mapData.fecha_real})`, font: { size: 14 } },
             xaxis: {
                 title: 'Longitud',
                 range: [-180, -60],
                 minallowed: -180,
                 maxallowed: -60,
                 constrain: 'domain',
                 tickmode: 'array', tickvals: lonTicks, ticktext: lonTicks.map(formatLon)
             },
             yaxis: {
                 title: 'Latitud',
                 range: [-30, 30],
                 minallowed: -30,
                 maxallowed: 30,

                 // 2. EL TRUCO CARTOGRÁFICO: Plate Carrée estricto
                 scaleanchor: 'x',     // Amarra la escala de Y a la de X
                 scaleratio: 1,        // Proporción matemática 1:1
                 constrain: 'domain',  // Obliga a encoger el área de trazado en lugar de estirar los datos

                 tickmode: 'array', tickvals: latTicks, ticktext: latTicks.map(formatLat)
             },
             plot_bgcolor: '#e2e8f0', margin: { l: 50, r: 20, t: 40, b: 40 }
         };

         Plotly.newPlot('map-container', datosMapa, layout, {responsive: true});
 }
main();
