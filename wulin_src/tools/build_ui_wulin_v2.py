# -*- coding: utf-8 -*-
"""
生成 ui_wulin_v2.xml：
- 新增入口按钮图/乌林大地图背景（DefineBitsLossless2 + DefineShape + DefineSprite）
- 复制 uiSkin_bigMap 为 uiSkin_bigMap_wulin（新背景 + 紫点位置 + 第10入口）
- uiSkin_Map 加 _wulinBtn（入口图，SymbolClass -> game.ui.WulinEntryButton）
用法: python tools/build_ui_wulin_v2.py <ui.xml> <out.xml>
"""
import sys, re, zlib, struct
from PIL import Image

ENTRY_PNG = "D:/_wulin_build/src/game/wulin/assets/wulin_entry.png"
MAP_PNG = "D:/_wulin_build/src/game/wulin/assets/wulin_map.png"

# character ids
ID_ENTRY_BMP = 61300
ID_MAP_BMP = 61301
ID_ENTRY_SHAPE = 61302
ID_ENTRY_SPRITE = 61303
ID_MAP_SHAPE = 61304
ID_WULIN_SKIN = 61310
ID_TENTH = 61311
ID_WULIN_BTN = 61330

DOTS = [
    (-330, 19), (-268, -28), (-220, -73), (-114, -94), (1, -28),
    (84, 122), (160, 129), (243, 87), (281, -21), (281, -125),
]
BUTTON_NAMES = [
    "_yingdirukouBtn", "_1_2Btn", "_shanzeiqianshaoBtn", "_2_3Btn",
    "_xunshanlujingBtn", "_xunshanyingdiBtn", "_5Btn", "_6Btn", "_7Btn",
]

def bit_tag(chid, path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    data = bytearray()
    for r, g, b, a in im.getdata():
        data += bytes((a, r, g, b))
    z = zlib.compress(bytes(data), 9)
    return '<item type="DefineBitsLossless2Tag" bitmapFormat="5" bitmapHeight="%d" bitmapWidth="%d" characterID="%d" forceWriteAsLong="true" zlibBitmapData="%s"/>' % (h, w, chid, z.hex())

def shape_tag(sid, bmp_id, rect_w, rect_h, scale, tx, ty):
    # rect_w/h in twips, centered; bitmap matrix scale twips/pixel
    hw = rect_w // 2
    hh = rect_h // 2
    nbits = max(1, (max(abs(hw), abs(hh))).bit_length() + 1)
    edge_bits = max(1, (max(rect_w, rect_h)).bit_length() + 1)
    mbits = max(1, (int(abs(scale) * 65536)).bit_length() + 1)
    tbits = max(1, (max(abs(tx), abs(ty))).bit_length() + 1)
    return f'''<item type="DefineShapeTag" forceWriteAsLong="false" shapeId="{sid}">
<shapeBounds type="RECT" Xmax="{hw}" Xmin="{-hw}" Ymax="{hh}" Ymin="{-hh}" nbits="{nbits}"/>
<shapes type="SHAPEWITHSTYLE" numFillBits="1" numLineBits="0">
<fillStyles type="FILLSTYLEARRAY">
<fillStyles>
<item type="FILLSTYLE" bitmapId="{bmp_id}" fillStyleType="65">
<bitmapMatrix type="MATRIX" hasRotate="false" hasScale="true" nRotateBits="0" nScaleBits="{mbits}" nTranslateBits="{tbits}" scaleX="{scale}" scaleY="{scale}" translateX="{tx}" translateY="{ty}"/>
</item>
</fillStyles>
</fillStyles>
<lineStyles type="LINESTYLEARRAY">
<lineStyles/>
</lineStyles>
<shapeRecords>
<item type="StyleChangeRecord" fillStyle0="1" moveBits="{nbits}" moveDeltaX="{-hw}" moveDeltaY="{-hh}" stateFillStyle0="true" stateFillStyle1="false" stateLineStyle="false" stateMoveTo="true" stateNewStyles="false"/>
<item type="StraightEdgeRecord" deltaX="{rect_w}" generalLineFlag="false" numBits="{edge_bits}" vertLineFlag="false"/>
<item type="StraightEdgeRecord" deltaY="{rect_h}" generalLineFlag="false" numBits="{edge_bits}" vertLineFlag="true"/>
<item type="StraightEdgeRecord" deltaX="{-rect_w}" generalLineFlag="false" numBits="{edge_bits}" vertLineFlag="false"/>
<item type="StraightEdgeRecord" deltaY="{-rect_h}" generalLineFlag="false" numBits="{edge_bits}" vertLineFlag="true"/>
<item type="EndShapeRecord" endOfShape="0"/>
</shapeRecords>
</shapes>
</item>'''

def place_simple(cid, depth, name, tx, ty, sx=None, sy=None, ntrans=15, nscale=18):
    nameattr = (' name="%s"' % name) if name else ''
    scaleflags = 'hasScale="false" nScaleBits="0"'
    scalestr = ''
    if sx is not None:
        scaleflags = 'hasScale="true" nScaleBits="%d"' % nscale
        scalestr = ' scaleX="%s" scaleY="%s"' % (sx, sy)
    return f'''<item type="PlaceObject2Tag" characterId="{cid}" depth="{depth}" forceWriteAsLong="true"{nameattr} placeFlagHasCharacter="true" placeFlagHasClipActions="false" placeFlagHasClipDepth="false" placeFlagHasColorTransform="false" placeFlagHasMatrix="true" placeFlagHasName="{'true' if name else 'false'}" placeFlagHasRatio="false" placeFlagMove="false">
<matrix type="MATRIX" hasRotate="false" {scaleflags} nRotateBits="0" nTranslateBits="{ntrans}"{scalestr} translateX="{tx}" translateY="{ty}"/>
</item>'''

def sprite_start(sid):
    return '<item type="DefineSpriteTag" forceWriteAsLong="true" frameCount="1" hasEndTag="true" spriteId="%d">\n<subTags>\n' % sid

def extract_placeobject(block, name):
    pos = block.find('name="%s"' % name)
    if pos < 0:
        raise RuntimeError('placeobject not found: ' + name)
    start = block.rfind('<item type="PlaceObject', 0, pos)
    if start < 0:
        raise RuntimeError('placeobject start not found: ' + name)
    end = block.find('</item>', pos)
    if end < 0:
        raise RuntimeError('placeobject end not found: ' + name)
    return block[start:end + len('</item>')]

def set_matrix(po, tx, ty):
    m = re.search(r'<matrix ([^>]*)/>', po)
    if not m:
        raise RuntimeError('matrix not found')
    attrs = m.group(1)
    attrs = re.sub(r'nTranslateBits="\d+"', 'nTranslateBits="15"', attrs)
    attrs = re.sub(r'translateX="-?\d+"', 'translateX="%d"' % tx, attrs)
    attrs = re.sub(r'translateY="-?\d+"', 'translateY="%d"' % ty, attrs)
    return po[:m.start()] + '<matrix ' + attrs + '/>' + po[m.end():]

def set_name_depth(po, name, depth):
    po = re.sub(r'name="[^"]*"', 'name="%s"' % name, po, count=1)
    po = re.sub(r'depth="\d+"', 'depth="%d"' % depth, po, count=1)
    return po

def main():
    src = sys.argv[1]
    out = sys.argv[2]
    xml = open(src, 'r', encoding='utf-8-sig').read()

    # --- entry / map bitmaps and shapes ---
    map_bmp = bit_tag(ID_MAP_BMP, MAP_PNG)
    # map shape: 770x500 px -> 15400x10000 twips, cover scale
    iw, ih = Image.open(MAP_PNG).size
    sc = max(15400.0 / iw, 10000.0 / ih)
    tx = -7700
    ty = int(round(-5000 - (ih * sc - 10000) / 2.0))
    map_shape = shape_tag(ID_MAP_SHAPE, ID_MAP_BMP, 15400, 10000, round(sc, 6), tx, ty)


    # --- original bigmap skin block ---
    big_start = xml.find('spriteId="61109"')
    if big_start < 0:
        raise RuntimeError('uiSkin_bigMap not found')
    item_start = xml.rfind('<item type="DefineSpriteTag"', 0, big_start)
    sub_start = xml.find('<subTags>', big_start)
    sub_end = xml.find('</subTags>', sub_start)
    end = xml.find('</item>', sub_end) + len('</item>')
    big_block = xml[item_start:end]

    # 9 art children for 10th button
    tenth_arts = []
    for i, name in enumerate(BUTTON_NAMES):
        po = extract_placeobject(big_block, name)
        po = set_name_depth(po, '_art%d' % i, i + 1)
        po = set_matrix(po, 0, 0)
        tenth_arts.append(po)
    tenth_sprite = (sprite_start(ID_TENTH) + '\n'.join(tenth_arts) +
                    '\n<item type="ShowFrameTag" forceWriteAsLong="false"/>\n</subTags>\n</item>\n')

    # --- wulin skin copy ---
    skin = big_block.replace('spriteId="61109"', 'spriteId="%d"' % ID_WULIN_SKIN)
    if 'characterId="61110"' not in skin:
        raise RuntimeError('bigmap background not found')
    skin = skin.replace('characterId="61110"', 'characterId="%d"' % ID_MAP_SHAPE)
    for i, name in enumerate(BUTTON_NAMES):
        po = extract_placeobject(skin, name)
        tx2, ty2 = DOTS[i][0] * 20, DOTS[i][1] * 20
        npo = set_matrix(po, tx2, ty2)
        skin = skin.replace(po, npo, 1)
    # add 10th button before ShowFrame
    sf = skin.find('<item type="ShowFrameTag"')
    if sf < 0:
        raise RuntimeError('wulin skin no ShowFrame')
    tenth_place = place_simple(ID_TENTH, 201, '_wulin10Btn', 5620, -2500)
    skin = skin[:sf] + tenth_place + '\n' + skin[sf:]

    # --- entry button in uiSkin_Map (sprite 958) ---
    map_start = xml.find('spriteId="958"')
    if map_start < 0:
        raise RuntimeError('uiSkin_Map not found')
    ms = xml.find('<subTags>', map_start)
    msf = xml.find('<item type="ShowFrameTag"', ms)
    if msf < 0:
        raise RuntimeError('uiSkin_Map no ShowFrame')
    entry_raw = place_simple(61172, 200, '_wulinArt', -1200, -1400)
    xml = xml[:msf] + entry_raw + '\n' + xml[msf:]

    # --- append new tags before root </tags> ---
    new_tags = map_bmp + '\n' + map_shape + '\n' + tenth_sprite + skin
    symbol_tag = '''<item type="SymbolClassTag" forceWriteAsLong="true">
<tags>
<item>%d</item>
<item>%d</item>
</tags>
<names>
<item>game.ui.SkinBigMapWulin</item>
<item>game.ui.Wulin10Button</item>
</names>
</item>''' % (ID_WULIN_SKIN, ID_TENTH)
    root_end = xml.rfind('</tags>')
    if root_end < 0:
        raise RuntimeError('root tags not found')
    xml = xml[:root_end] + new_tags + '\n' + symbol_tag + '\n' + xml[root_end:]
    open(out, 'w', encoding='utf-8').write(xml)
    print('written', out, len(xml))

if __name__ == '__main__':
    main()
