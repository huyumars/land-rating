# 上海免费真实数据

此目录的 POI 来自 OpenStreetMap 社区数据，由 Geofabrik 提供上海全市 `.osm.pbf` 下载。未使用高德或其他需要账号的设施接口，没有模拟设施。

- 数据来源：<https://download.geofabrik.de/asia/china/shanghai.html>
- 原始下载：<https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf>
- 使用许可：ODbL 1.0，<https://www.openstreetmap.org/copyright>
- 标注：`© OpenStreetMap contributors`
- 坐标：WGS84，经度在前、纬度在后。不要直接当 GCJ-02 坐标覆盖到高德底图。
- 快照时间、提取时间、SHA-256、各类数量见 `metadata.json`；数据文件也内嵌相同 metadata。

## 文件结构

`pois.geojson` 是 GeoJSON FeatureCollection，每项为一个点：

```json
{
  "type": "Feature",
  "id": "node/123",
  "geometry": { "type": "Point", "coordinates": [121.47, 31.23] },
  "properties": {
    "id": "node/123",
    "name": "设施名称",
    "category": "cafe",
    "source": "OpenStreetMap",
    "osmUrl": "https://www.openstreetmap.org/node/123",
    "pointType": "osm_node",
    "named": true
  }
}
```

上例仅说明结构；实际文件均来自下载数据。`category` 为 `cafe`、`mall`、`school`、`metro`。

| 类别 | 实际筛选条件 | 口径 |
| --- | --- | --- |
| 咖啡店 | `amenity=cafe` | 包含此标签的咖啡馆，不能保证所有咖啡销售点都被收录 |
| 商场 | `shop=mall` | 商场，不把普通零售店与超市自动当作商场 |
| 学校 | `amenity=school` | 不包含仅标为大学、幼儿园的设施；学校类型可能缺失 |
| 地铁入口 | `railway=subway_entrance` | 地铁出入口；保留同站不同入口，不使用站点中心冒充入口 |

`boundary.geojson` 优先取同一 PBF 中的上海市 `admin_level=4` 行政边界。行政边界可能包含海域。若无法提取，会明确标为 Geofabrik 下载覆盖范围，不能当作行政边界。下载范围含缓冲区域，POI 可能包含邻近省份的设施，这有利于计算边缘网格的最近设施。

`water.geojson` 从同一数据提取 `natural=water` 或 `waterway=riverbank` 的已绘制水面，保拓扑简化约 2 米，用于跳过中心落在河湖中的网格。它不是完整海洋或可通行土地掩膜，岸线近似，未映射水面仍可能遗漏。

## 一次下载，多次计算

前端可直接读取此静态文件。权重、分数曲线、距离阈值调整不需要下载；网格位置/大小变化时在本机重新算直线距离即可。新增类别需要重新提取原始 PBF；PBF 已含的类别不需要再次下载。只有希望更新开店/关店等变化时才需要刷新快照。

原始 PBF 和隔离环境放在 `.cache/`，不应发布到前端，也不应提交版本库。

## 重跑

在 `shanghai-access` 项目目录运行：

```sh
python3 -m venv .cache/data-venv
.cache/data-venv/bin/python -m pip install -r scripts/requirements-data.txt
.cache/data-venv/bin/python scripts/extract_osm.py
```

脚本仅在缓存缺失时下载公开数据；加 `--refresh` 刷新。离线时可传 `--pbf PATH --poly PATH` 使用已有数据。依赖安装需要联网；前端运行和重复评分不依赖 Python。

## 质量和使用边界

1. 这是 OSM 中已收录的设施，不是完整商业名录。覆盖稀疏地区可能因为缺数据而得分低；不应将其解释为当地确实没有设施。
2. 距离是地理直线距离，不是步行导航。江河、围墙、封闭园区、天桥和通行限制均未建模。
3. 面设施使用保证位于面内的代表点（`polygon_representative_point`），不是实测入口；较大校园、商场可能出现距离偏差。
4. 同名点落在对应设施面内时，移除点以减少重复；其余潜在重复保留。未命名对象保留并明确显示为未命名。
5. 学校距离不代表学区划分、入学资格、教育质量或公众可进入。
6. 数据会变化，应在页面显示快照时间，并支持后续刷新。分享和发布数据、衍生数据库时遵守 ODbL 的署名及适用的相同方式共享要求。

MapLibre 是渲染器，不附带可离线使用的底图。本目录没有批量下载公共 OSM 瓦片；公共瓦片服务使用和缓存应遵守对应服务条款。
