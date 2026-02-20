const csvFileName = 'data/datos_climaticos_1940_2024.csv';
let pyodide;
let trazoContinentes = null; // Guardará las costas del mundo

// Función para descargar y procesar las geometrías de los continentes
async function cargarGeometriasMundo() {
    try {
        // GeoJSON ligero de los países del mundo
        const res = await fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json');
        const data = await res.json();

        let lon = [], lat = [];

        // Extraer vértices para Plotly (separando polígonos con 'null')
        data.features.forEach(feature => {
            const geom = feature.geometry;
            if (!geom) return;

            if (geom.type === 'Polygon') {
                geom.coordinates.forEach(ring => {
                    ring.forEach(pt => { lon.push(pt[0]); lat.push(pt[1]); });
                    lon.push(null); lat.push(null); // Cortar la línea para el siguiente polígono
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

        // Creamos un trazo transparente de líneas para Plotly
        trazoContinentes = {
            x: lon,
            y: lat,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#0f172a', width: 1.2 }, // Color y grosor de la costa
            hoverinfo: 'skip',
            showlegend: false
        };
    } catch (error) {
        console.warn("No se pudieron cargar las geometrías del mapa: ", error);
    }
}

async function main() {
    const loadingText = document.getElementById("loading-text");

    try {
        // Iniciar la descarga de los continentes en paralelo con Python
        const promesaContinentes = cargarGeometriasMundo();

        loadingText.innerText = "Cargando ecosistema Xarray y Zarr...";
        pyodide = await loadPyodide();
        await pyodide.loadPackage(["pandas", "numpy", "xarray", "zarr", "fsspec", "numcodecs", "cftime", "requests", "aiohttp"]);

        loadingText.innerText = "Procesando Dataset Histórico...";
        const response = await fetch(csvFileName);
        if (!response.ok) throw new Error("No se encontró el archivo CSV local.");
        const csvText = await response.text();

        pyodide.globals.set("csv_content", csvText);

        await pyodide.runPythonAsync(`
        import pandas as pd
        import numpy as np
        import io
        import json

        df = pd.read_csv(io.StringIO(csv_content))
        df['Fecha'] = pd.to_datetime(df['Fecha'])
        df = df.set_index('Fecha')
        columnas_disponibles = list(df.columns)
        `);

        const columnas = pyodide.globals.get("columnas_disponibles").toJs();
        const select_elem = document.getElementById("indicesSelect");
        columnas.forEach(col => {
            const option = document.createElement("option");
            option.text = col.replace(/_/g, ' ');
            option.value = col;
            if (['ONI', 'ICEN_E'].includes(col)) option.selected = true;
            select_elem.add(option);
        });

        // Esperamos a que los continentes terminen de cargar
        await promesaContinentes;

        document.getElementById("loader-overlay").style.display = "none";
        const controls = document.getElementById("main-controls");
        controls.style.opacity = "1";
        controls.style.pointerEvents = "auto";

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

   if (selectedIndices.length === 0) return alert("Selecciona un índice.");

   pyodide.globals.set("selected_cols", selectedIndices);
   pyodide.globals.set("yStart", yStart);
   pyodide.globals.set("yEnd", yEnd);

   const tracesJson = await pyodide.runPythonAsync(`
   mask = (df.index.year >= yStart) & (df.index.year <= yEnd)
   df_filtered = df.loc[mask]

   traces = []
   for col in selected_cols:
       # ESTOS ESPACIOS SON VITALES EN PYTHON
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
       yaxis: { title: 'Anomalía Estándar', showgrid: true, gridcolor: '#f1f5f9', zeroline: true, zerolinecolor: '#1e293b' },
       plot_bgcolor: '#ffffff', paper_bgcolor: '#ffffff',
       hovermode: 'x unified',
       margin: { l: 50, r: 20, t: 30, b: 40 }
   };
   Plotly.newPlot('ts-container', plotData, layout, {responsive: true});
}

async function generarMapa() {
    const year = parseInt(document.getElementById("mapYear").value);
    const month = parseInt(document.getElementById("mapMonth").value);

    pyodide.globals.set("map_year", year);
    pyodide.globals.set("map_month", month);

    const mapContainer = document.getElementById("map-container");
    // Mostramos el spinner
    mapContainer.innerHTML = "<div class='spinner' style='margin:auto; display:block; margin-top:100px;'></div><p style='text-align:center; color:#64748b;'>Leyendo chunk desde Zarr...</p>";

    const mapDataJson = await pyodide.runPythonAsync(`
      import pandas as pd
      import numpy as np
      import xarray as xr
      import requests
      import json
      import zarr
      from collections.abc import MutableMapping
      from js import window

      fecha_str = f"{map_year}-{map_month:02d}-01"

      oni_val = 0.0
      if fecha_str in df.index:
          oni_val = df.loc[fecha_str, 'ONI']
          if pd.isna(oni_val): oni_val = 0.0

      base_url = window.location.href.split('?')[0].split('#')[0].rsplit('/', 1)[0]
      zarr_url = f"{base_url}/data/datos_sst_optimizados.zarr"

      class BrowserHTTPStore(MutableMapping):
          def __init__(self, url):
              self.url = url.rstrip('/')
              self.session = requests.Session()
              # --- SOLUCIÓN HEADERS ---
              # Borramos los headers de Python para que el navegador no se queje de "Forbidden header"
              self.session.headers.clear()

          def _es_peticion_invalida(self, key):
              if key == '.zarray' or '.zgroup/' in key or '.zattrs/' in key:
                  return True
              return False

          def __getitem__(self, key):
              if self._es_peticion_invalida(key):
                  raise KeyError(key)

              res = self.session.get(f"{self.url}/{key}")
              if res.status_code == 200:
                  return res.content
              raise KeyError(key)

          def __setitem__(self, key, value): pass
          def __delitem__(self, key): pass

          def __iter__(self):
              return iter([
                  '.zgroup', '.zattrs',
                  'sst/.zarray', 'sst/.zattrs',
                  'time/.zarray', 'time/.zattrs',
                  'lat/.zarray', 'lat/.zattrs',
                  'lon/.zarray', 'lon/.zattrs'
              ])

          def __len__(self): return 10

          def __contains__(self, key):
              if self._es_peticion_invalida(key):
                  return False
              return self.session.head(f"{self.url}/{key}").status_code == 200

      raw_store = BrowserHTTPStore(zarr_url)
      store = zarr.storage.KVStore(raw_store)
      ds_zarr = xr.open_zarr(store, consolidated=False)

      try:
          mapa_mes = ds_zarr['sst'].sel(time=fecha_str, method='nearest')
          fecha_real = str(mapa_mes.time.values)[:10]

          z_vals = mapa_mes.values.astype(float)
          lon_vals = mapa_mes.lon.values.astype(float)
          lat_vals = mapa_mes.lat.values.astype(float)

          z_vals_clean = np.where(np.isnan(z_vals), None, z_vals).tolist()

          result = {
              'z': z_vals_clean,
              'x': lon_vals.tolist(),
              'y': lat_vals.tolist(),
              'oni': round(oni_val, 2),
              'fecha_solicitada': fecha_str,
              'fecha_real': fecha_real
          }
      except Exception as e:
          result = {'error': str(e)}

      json.dumps(result)
    `);

    const mapData = JSON.parse(mapDataJson);

    // --- SOLUCIÓN SPINNER ---
    // Limpiamos estrictamente todo el HTML del contenedor antes de dibujar
    mapContainer.innerHTML = "";

    if (mapData.error) {
        mapContainer.innerHTML = `<p style='color:red; text-align:center; margin-top:100px;'>Error leyendo Zarr: ${mapData.error}</p>`;
        return;
    }

    const capaTemperatura = {
        z: mapData.z,
        x: mapData.x,
        y: mapData.y,
        type: 'contour',
        colorscale: 'RdBu',
        reversescale: false,
        zmin: -3,
        zmax: 3,
        contours: { coloring: 'heatmap' },
        colorbar: { title: 'SST Anomaly (°C)' }
    };

    const datosMapa = [capaTemperatura];
    if (trazoContinentes) datosMapa.push(trazoContinentes);

    const layout = {
        title: { text: `Anomalía SST (ERA5): ${mapData.fecha_real} (ONI: ${mapData.oni})`, font: { size: 14 } },
        xaxis: { title: 'Longitud', range: [-180, -60], constrain: 'domain' },
        yaxis: { title: 'Latitud', range: [-30, 30], scaleanchor: 'x', scaleratio: 1 },
        plot_bgcolor: '#e2e8f0',
        margin: { l: 50, r: 20, t: 40, b: 40 }
    };

    Plotly.newPlot('map-container', datosMapa, layout, {responsive: true});
}

main();
