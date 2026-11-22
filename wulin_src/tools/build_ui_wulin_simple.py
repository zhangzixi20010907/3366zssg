# -*- coding: utf-8 -*-
"""在 uiSkin_Map 中加入原始 61172 建筑图 _wulinArt（无 SymbolClass）。"""
import sys
src=sys.argv[1]; out=sys.argv[2]
xml=open(src,encoding='utf-8-sig').read()
start=xml.find('spriteId="958"')
if start<0: raise SystemExit('uiSkin_Map not found')
sub=xml.find('<subTags>',start)
sf=xml.find('<item type="ShowFrameTag"',sub)
if sf<0: raise SystemExit('no ShowFrame')
place='''<item type="PlaceObject2Tag" characterId="61172" depth="200" forceWriteAsLong="true" name="_wulinArt" placeFlagHasCharacter="true" placeFlagHasClipActions="false" placeFlagHasClipDepth="false" placeFlagHasColorTransform="false" placeFlagHasMatrix="true" placeFlagHasName="true" placeFlagHasRatio="false" placeFlagMove="false">
<matrix type="MATRIX" hasRotate="false" hasScale="false" nRotateBits="0" nScaleBits="0" nTranslateBits="14" translateX="-1200" translateY="-1400"/>
</item>'''
xml=xml[:sf]+place+'\n'+xml[sf:]
open(out,'w',encoding='utf-8').write(xml)
print('written',out,len(xml))
