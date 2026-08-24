import json, io
B = "7a3e1c22-0000-4000-8000-0000000000"
DS = B + "01"
PG = B + "02"

def q(n, text):
    return {"id": B + "1%d" % n, "dataSource": {"kind": "manual", "dataSourceId": DS},
            "text": text, "usedVariables": []}

def tile(n, title, qid, x, y, w, h, vt, opts):
    return {"id": B + "2%d" % n, "title": title, "pageId": PG,
            "layout": {"x": x, "y": y, "width": w, "height": h},
            "queryRef": {"kind": "query", "queryId": qid},
            "visualType": vt, "visualOptions": opts}

def card(col):
    return {"multiStat__textSize": "auto", "colorRulesDisabled": True,
            "multiStat__valueColumn": col}

S = "ExecutiveScorecard()"
queries = [
    q(0, S + " | project OnTimePct"),
    q(1, S + " | project VarianceToBenchmark"),
    q(2, S + " | project Vehicles"),
    q(3, S + " | project Routes"),
    q(4, S + " | project Disruptions"),
    q(5, S + " | project P90DelaySec"),
    q(6, "PerformanceTrend() | project Day, OnTimePct, Benchmark"),
    q(7, "PeakComparison() | project Period, OnTimePct"),
    q(8, "WorstCorridors() | project RouteId, Mode, Vehicles, LatePct, MedianDelaySec, WorstDelayMin"),
    q(9, "ChronicUnderperformers() | project RouteId, Mode, DaysMeasured, DaysBelowBenchmark, BreachRate, AvgOnTimePct"),
]
tiles = [
    tile(0, "On time performance (24h)", queries[0]["id"], 0, 0, 4, 3, "card", card("OnTimePct")),
    tile(1, "Variance to 90 percent benchmark", queries[1]["id"], 4, 0, 4, 3, "card", card("VarianceToBenchmark")),
    tile(2, "Vehicles in service", queries[2]["id"], 8, 0, 4, 3, "card", card("Vehicles")),
    tile(3, "Routes operating", queries[3]["id"], 12, 0, 4, 3, "card", card("Routes")),
    tile(4, "Active disruptions", queries[4]["id"], 16, 0, 4, 3, "card", card("Disruptions")),
    tile(5, "90th percentile delay seconds", queries[5]["id"], 20, 0, 4, 3, "card", card("P90DelaySec")),
    tile(6, "Daily on time trend against benchmark", queries[6]["id"], 0, 3, 14, 9, "linechart",
         {"xColumn": {"type": "infer"}, "yColumns": {"type": "infer"},
          "yAxisMinimumValue": 0, "yAxisMaximumValue": 100, "hideLegend": False,
          "xColumnTitle": "Day", "yColumnTitle": "On time percent"}),
    tile(7, "On time by service period", queries[7]["id"], 14, 3, 10, 9, "bar",
         {"xColumn": {"type": "infer"}, "yColumns": {"type": "infer"},
          "hideLegend": True, "yColumnTitle": "On time percent"}),
    tile(8, "Corridors needing intervention now", queries[8]["id"], 0, 12, 12, 9, "table", {}),
    tile(9, "Chronic underperformers across repeated days", queries[9]["id"], 12, 12, 12, 9, "table", {}),
]
d = {
    "id": B + "00", "schema_version": "52", "title": "TTCExecutiveView",
    "autoRefresh": {"enabled": True, "defaultInterval": "5m", "minimumInterval": "1m"},
    "baseQueries": [], "parameters": [],
    "dataSources": [{"id": DS, "name": "TTCOperations", "scopeId": "kusto",
                     "kind": "manual-kusto", "clusterUri": "{{KQL_CLUSTER_URI}}",
                     "database": "{{KQL_DATABASE}}"}],
    "pages": [{"id": PG, "name": "Service performance"}],
    "queries": queries, "tiles": tiles,
}
json.dump(d, io.open("fabric/dashboard-exec/ExecutiveDashboard.json", "w", encoding="utf-8"),
          indent=2, ensure_ascii=False)
print("queries=%d tiles=%d" % (len(queries), len(tiles)))
