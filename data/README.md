# 上海免费真实数据

此目录的 POI 来自 OpenStreetMap 社区数据，由 Geofabrik 提供上海全市 `.osm.pbf` 下载。未使用高德或其他需要账号的设施接口，没有模拟设施。

- 数据来源：<https://download.geofabrik.de/asia/china/shanghai.html>
- 原始下载：<https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf>
- 使用许可：ODbL 1.0，<https://www.openstreetmap.org/copyright>
- 标注：`© OpenStreetMap contributors`
- 坐标：WGS84，经度在前、纬度在后。不要直接当 GCJ-02 坐标覆盖到高德底图。
- 快照时间、提取时间、SHA-256、各类点数和去重后的设施组数见 `metadata.json`；数据文件也内嵌相同 metadata。六类均从同一份 PBF 提取，增加类别不会混入不同日期的数据。

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
    "named": true,
    "groupId": "cafe:node/123",
    "groupName": "设施名称",
    "groupingMethod": "individual_osm_object"
  }
}
```

上例仅说明结构；实际文件均来自下载数据。`category` 为 `cafe`、`mall`、`school`、`metro`、`sports`、`library`。同一个 OSM 对象选择一个主分类，`id` 在文件内全局唯一。

| 类别 | 实际筛选条件 | 口径 |
| --- | --- | --- |
| 咖啡店 | `amenity=cafe` | 包含此标签的咖啡馆，不能保证所有咖啡销售点都被收录 |
| 商场 | `shop=mall` | 商场，不把普通零售店与超市自动当作商场 |
| 学校 | `amenity=school` | 不包含仅标为大学、幼儿园的设施；学校类型可能缺失 |
| 地铁入口 | `railway=subway_entrance` | 地铁出入口；保留同站不同入口，不使用站点中心冒充入口 |
| 运动设施 | `leisure=sports_centre/ sports_hall/ fitness_centre/ fitness_station/ pitch/ swimming_pool/ track/ stadium` | 体育中心、体育馆、健身房、户外健身设施、球场、泳池、跑道、体育场；仅有 `sport=*` 而没有这些 leisure 标签的设施不自动加入 |
| 图书馆 | `amenity=library` | 不把书店、流动图书服务和公共书箱自动视为图书馆 |

运动设施和图书馆排除明确 `access=no/private` 的对象。位于已绘制私有运动设施面内的运动子设施也排除；`customers`、`members`、`membership`、`permit` 等条件开放设施保留原始 `access`。原有四类保持原筛选口径；没有 access 标签不等于公众可进入，不自动推断校园或小区的开放情况。

参考 OSM 官方标签文档：[图书馆](https://wiki.openstreetmap.org/wiki/Tag:amenity=library)、[体育中心](https://wiki.openstreetmap.org/wiki/Tag:leisure=sports_centre)、[健身房](https://wiki.openstreetmap.org/wiki/Tag:leisure=fitness_centre)、[户外健身](https://wiki.openstreetmap.org/wiki/Tag:leisure=fitness_station)、[球场](https://wiki.openstreetmap.org/wiki/Tag:leisure=pitch)、[访问权限](https://wiki.openstreetmap.org/wiki/Key:access)。

## 数量去重和设施分组

周边数量按每类的 `groupId` 去重，同组采用其所有成员中最近的距离判断是否进入半径；原始入口/子设施点保留用于最近距离展示。`metadata.counts` 是点数，`metadata.groupCounts` 是设施组数。数据中的 OSM id 保持稳定；OSM 站点归属和边界改变时，后续快照的分组可能改变。

地铁依次采用：

1. 入口作为 `public_transport=stop_area` 关系成员时，使用明确的站点归属；若有 `stop_area_group`，归入同一组。共享入口或相同地铁站节点的关系归并。
2. 同名地铁站节点（仅正规化空白和括号中的号线注释）之间距离不超过 **350 米** 才归并，绝不按全市同名合并。
3. 无明确关系的入口关联到 **350 米内最近**、带 `station=subway` 或 `subway=yes` 的 `railway=station/public_transport=station` 对象。记录 `groupingMethod=nearest_metro_station_within_350m`、站点坐标和关联距离；这是一项地理推断，无法保证通道归属。
4. 无法关联的入口保留为独立组 `unassociated_entrance`；`metadata.grouping.metro` 精确记录数量和 ID，因此此时仍可能把同站多个入口计成多个站。

参见 [stop_area](https://wiki.openstreetmap.org/wiki/Tag:public_transport=stop_area)、[subway_entrance](https://wiki.openstreetmap.org/wiki/Tag:railway=subway_entrance)。显式关系归属不受 350 米启发式阈值限制；同名和最近站点回退均有距离限制，不能视为经过人工审核的物理换乘站清单。

运动设施：完整落在已绘制 `sports_centre/sports_hall/stadium` 面内的球场、泳池、跑道等归同一外层场馆组；同组子设施继续保留。包含判断使用原始完整几何，不能仅因代表点在面内就归并。没有场馆面时独立计数，邻近多个球场仍可能被计为多个设施。线状跑道取中点作为距离代表点，点类型为 `line_representative_point`。

其他类别默认一条保留的 OSM 对象一组。已有“同名点位于同类设施面内”的去重规则继续应用，剩余潜在点面或多面重复不作无证据合并。

### 当前快照检查

六类均来自 **2026-10-20T20:23:47Z** 快照，共 9,687 个点、8,386 个设施组。

| 类别 | 点数 | 设施组数 |
| --- | ---: | ---: |
| 咖啡店 | 1,634 | 1,634 |
| 商场 | 540 | 540 |
| 学校 | 2,275 | 2,275 |
| 地铁 | 1,493 个入口 | 370 |
| 运动设施 | 3,614 | 3,436 |
| 图书馆 | 131 | 131 |

地铁 1,484 个入口使用显式关系，9 个使用最近站点回退，最远回退距离 168.363 米，无未关联入口。运动场馆归并 178 个内部子设施；排除 32 个明确 private/no 运动设施。保留 16 个 customers、1 个 permit 运动设施；大多数运动设施和全部图书馆没有 access 标签，不能据此保证公众开放。更新快照后以 metadata 中统计为准。

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
.cache/data-venv/bin/python -m unittest discover -s scripts -p 'test_extract_osm.py'
```

脚本仅在缓存缺失时下载公开数据；加 `--refresh` 刷新。离线时可传 `--pbf PATH --poly PATH` 使用已有数据。依赖安装需要联网；前端运行和重复评分不依赖 Python。

## 质量和使用边界

1. 这是 OSM 中已收录的设施，不是完整商业名录。覆盖稀疏地区可能因为缺数据而得分低；不应将其解释为当地确实没有设施。
2. 距离是地理直线距离，不是步行导航。江河、围墙、封闭园区、天桥和通行限制均未建模。
3. 面设施使用保证位于面内的代表点（`polygon_representative_point`），不是实测入口；较大校园、商场可能出现距离偏差。
4. 同名点落在对应设施面内时，移除点以减少重复；其余潜在重复保留。未命名对象保留并明确显示为未命名。
5. 学校距离不代表学区划分、入学资格、教育质量或公众可进入。
6. 数据会变化，应在页面显示快照时间，并支持后续刷新。分享和发布数据、衍生数据库时遵守 ODbL 的署名及适用的相同方式共享要求。
7. 地铁站分组存在有边界距离的启发式回退，少量未关联入口单独计数；运动组依赖已绘制场馆边界。这些数量是当前数据和规则下的设施组数，不是经过核验的机构总数。

MapLibre 是渲染器，不附带可离线使用的底图。本目录没有批量下载公共 OSM 瓦片；公共瓦片服务使用和缓存应遵守对应服务条款。
