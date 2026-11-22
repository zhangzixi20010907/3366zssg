package game.ui
{
   import com.iflashigame.controller.AESController;
   import com.iflashigame.sound.MySound;
   import com.iflashigame.utils.Tools;
   import flash.display.Bitmap;
   import flash.display.BitmapData;
   import flash.display.DisplayObject;
   import flash.display.MovieClip;
   import flash.display.Shape;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.MouseEvent;
   import flash.filters.GlowFilter;
   import flash.geom.Point;
   import flash.display.Loader;
   import flash.net.URLRequest;
   import flash.system.ApplicationDomain;
   import flash.text.TextField;
   import flash.text.TextFormat;
   import flash.text.TextFormatAlign;
   import game.Config;
   import game.Data;
   import game.Fight;
   import game.Logic;
   import game.SoundCode;
   import game.UI;
   import game.events.FightEvent;
   import game.events.UIEvent;
   import game.fuben.WulinBossGate;
   import game.model.ArmyInfo;
   import game.model.Head;
   import game.model.RoleModel;
   import game.model.RoleStatus;
   import game.model.Type;

   /**
    * 乌林遗迹（大地图模式）。
    * 皮肤 uiSkin_bigMap_wulin 完全在 ui.swf 里；本类只做逻辑。
    */
   public class bigmap_wulin extends Sprite
   {
      public static const PART:int = 12;
      public static const LEVEL_COUNT:int = 10;
      public static const FIRST_GATE_ID:int = 201;
      private static const BOSS_LEVELS:Array = [5,10];
      private static const LEVEL_REQ:Array = [5,10,15,20,25,30,35,40,45,50];
      private static const LEVEL_NAME:Array = ["乌林小径","荒废驿站","林间岗哨","乌林营地","乌林守将","乱石坡","枯木栈道","遗迹入口","祭坛长廊","乌林之主"];
      private static const LEVEL_DESC:Array = [
         "沿乌林小径探查，林间雾瘴弥漫。",
         "废弃驿站中有敌军斥候出没。",
         "林间岗哨由弓手把守，小心伏击。",
         "乌林营地囤积粮草，守军众多。",
         "乌林守将现身！一场 BOSS 战即将开始。",
         "穿过乱石坡，前沿敌军严阵以待。",
         "枯木栈道狭窄，敌军以逸待劳。",
         "遗迹入口被重兵封锁。",
         "祭坛长廊深处传来擂鼓声。",
         "乌林之主亲自迎战！击败他即可通关。"
      ];
      private static const BUTTON_NAMES:Array = [
         "_yingdirukouBtn","_1_2Btn","_shanzeiqianshaoBtn","_2_3Btn",
         "_xunshanlujingBtn","_xunshanyingdiBtn","_5Btn","_6Btn",
         "_7Btn","_wulin10Btn"
      ];

      private static const POSITIONS:Array = [
         [-330,19],[-268,-28],[-220,-73],[-114,-94],[1,-28],
         [84,122],[160,129],[243,87],[281,-21],[281,-125]
      ];

      private var _ui:UI;
      private var _skinClass:Class;
      private var _bgLoaded:Boolean = false;
      private var _skin:MovieClip;
      private var _nameTF:TextField;
      private var _infoTF:TextField;
      private var _titleTF:TextField;
      private var _closeBtn:MovieClip;
      private var _levelButtons:Array;
      private var _fight:Fight;
      private var _bossGate:WulinBossGate;
      private var _fightBg:Sprite;
      private var _fightLevel:int = 0;
      private var _inFight:Boolean = false;
      private var _awaitingResult:Boolean = false;
      private var _captureAdded:Boolean = false;

      public function bigmap_wulin(ui:UI)
      {
         super();
         this._ui = ui;
         this._levelButtons = [];
         this.buildView();
         this.initCapture();
         this.refresh();
      }

      private function buildView() : void
      {
         var skinCls:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.BIG_MAP) as Class;
         if(skinCls == null)
         {
            throw new Error("找不到 uiSkin_bigMap");
         }
         this._skinClass = skinCls;
         this._skin = new skinCls() as MovieClip;
         addChild(this._skin);
         this.applyMapBackground();

         this._nameTF = this._skin.getChildByName("_nameTF") as TextField;
         this._infoTF = this._skin.getChildByName("_infoTF") as TextField;

         var i:int = 0;
         while(i < BUTTON_NAMES.length)
         {
            var btn:MovieClip = this._skin.getChildByName(String(BUTTON_NAMES[i])) as MovieClip;
            if(btn == null && i == 9)
            {
               btn = this.cloneRandomBigmapButton();
            }
            this._levelButtons.push(btn);
            if(btn != null)
            {
               btn["wulinLevel"] = i + 1;
               btn.x = Number(POSITIONS[i][0]);
               btn.y = Number(POSITIONS[i][1]);
               btn.buttonMode = true;
               btn.addEventListener(MouseEvent.CLICK,this.onLevelClick);
               btn.addEventListener(MouseEvent.MOUSE_OVER,this.onButtonOver);
               btn.addEventListener(MouseEvent.MOUSE_OUT,this.onButtonOut);
            }
            i++;
         }

         this._closeBtn = this._skin.getChildByName("_chuzhengBtn") as MovieClip;
         if(this._closeBtn != null)
         {
            this._closeBtn.buttonMode = true;
            this._closeBtn.addEventListener(MouseEvent.CLICK,this.onCloseClick);
            this._closeBtn.addEventListener(MouseEvent.MOUSE_OVER,this.onButtonOver);
            this._closeBtn.addEventListener(MouseEvent.MOUSE_OUT,this.onButtonOut);
         }

         this.bindNav("_wujiangBtn",UIEvent.OPEN_WUJIANG);
         this.bindNav("_shopBtn",UIEvent.OPEN_SHOP);
         this.bindNav("_beibaoBtn",UIEvent.OPEN_BEIBAO);
         this.bindNav("_buduiBtn",UIEvent.OPEN_BUDUI);
         this.bindNav("_taskBtn",UIEvent.TASK);
         this.bindNav("_jiangliBtn",UIEvent.JIANGLI);

         var soundMC:MovieClip = this._skin.getChildByName("_soundMC") as MovieClip;
         var waveMC:MovieClip = this._skin.getChildByName("_waveMC") as MovieClip;
         if(soundMC != null)
         {
            soundMC.buttonMode = true;
            soundMC.mouseChildren = false;
            soundMC.addEventListener(MouseEvent.CLICK,this.onSoundClick);
            soundMC.addEventListener(MouseEvent.MOUSE_OVER,this.onButtonOver);
            soundMC.addEventListener(MouseEvent.MOUSE_OUT,this.onButtonOut);
            if(MySound.getInstance().bkDisabled)
            {
               soundMC.gotoAndStop(2);
            }
         }
         if(waveMC != null)
         {
            waveMC.buttonMode = true;
            waveMC.mouseChildren = false;
            waveMC.addEventListener(MouseEvent.CLICK,this.onWaveClick);
            waveMC.addEventListener(MouseEvent.MOUSE_OVER,this.onButtonOver);
            waveMC.addEventListener(MouseEvent.MOUSE_OUT,this.onButtonOut);
            if(MySound.getInstance().eventDisabled)
            {
               waveMC.gotoAndStop(2);
            }
         }

         this.setImage(RoleModel.getInstance().imageID);
         this._titleTF = this.makeTitle("乌 林 遗 迹");
         addChild(this._titleTF);
      }

      private function applyMapBackground() : void
      {
         if(this._bgLoaded)
         {
            return;
         }
         var ld:Loader = new Loader();
         ld.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event) : void
         {
            var bmp:Bitmap = ld.content as Bitmap;
            if(bmp == null || this._skin == null)
            {
               return;
            }
            var areaW:Number = 770;
            var areaH:Number = 500;
            var ow:Number = bmp.width;
            var oh:Number = bmp.height;
            var sc:Number = Math.max(areaW / Math.max(ow,1),areaH / Math.max(oh,1));
            bmp.scaleX = bmp.scaleY = sc;
            bmp.x = -areaW / 2 - (ow * sc - areaW) / 2;
            bmp.y = -areaH / 2 - (oh * sc - areaH) / 2;
            var holder:Sprite = new Sprite();
            holder.addChild(bmp);
            var mask:Shape = new Shape();
            mask.graphics.beginFill(0);
            mask.graphics.drawRect(-areaW / 2,-areaH / 2,areaW,areaH);
            mask.graphics.endFill();
            holder.addChild(mask);
            bmp.mask = mask;
            var oldBg:DisplayObject = null;
            if(this._skin.numChildren > 0)
            {
               oldBg = this._skin.getChildAt(0);
            }
            try
            {
               this._skin.addChildAt(holder,0);
               if(oldBg != null)
               {
                  oldBg.visible = false;
               }
               this._bgLoaded = true;
            }
            catch(e1:Error)
            {
            }
         });
         ld.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event) : void
         {
         });
         try
         {
            ld.load(new URLRequest("wulin_map.png"));
         }
         catch(e2:Error)
         {
         }
      }

      private function cloneRandomBigmapButton() : MovieClip
      {
         try
         {
            var cls:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.BIG_MAP) as Class;
            if(cls == null)
            {
               return null;
            }
            var temp:MovieClip = new cls() as MovieClip;
            var idx:int = int(Math.random() * 9);
            var art:MovieClip = temp.getChildByName(String(BUTTON_NAMES[idx])) as MovieClip;
            if(art == null)
            {
               return null;
            }
            temp.removeChild(art);
            art.x = 0;
            art.y = 0;
            var mc:MovieClip = new MovieClip();
            mc.addChild(art);
            var hit:Shape = new Shape();
            hit.graphics.beginFill(0,0);
            hit.graphics.drawRect(-55,-120,110,126);
            hit.graphics.endFill();
            mc.addChild(hit);
            if(this._skin != null)
            {
               this._skin.addChild(mc);
            }
            return mc;
         }
         catch(e:Error)
         {
         }
         return null;
      }

      private function makeTitle(text:String) : TextField
      {
         var tf:TextField = new TextField();
         tf.selectable = false;
         tf.mouseEnabled = false;
         tf.multiline = false;
         tf.width = 260;
         tf.height = 42;
         tf.x = -130;
         tf.y = -238;
         var fmt:TextFormat = new TextFormat();
         fmt.font = "SimSun";
         fmt.size = 28;
         fmt.bold = true;
         fmt.color = 0xffee88;
         fmt.align = TextFormatAlign.CENTER;
         tf.defaultTextFormat = fmt;
         tf.text = text;
         tf.filters = [new GlowFilter(0x000000,1,3,3,3,1)];
         return tf;
      }

      private function setImage(imageID:int) : void
      {
         try
         {
            var cls:Class = ApplicationDomain.currentDomain.getDefinition("image" + imageID) as Class;
            if(cls == null)
            {
               return;
            }
            var mc:MovieClip = new cls() as MovieClip;
            mc.x = -378;
            mc.y = -245;
            addChild(mc);
         }
         catch(e:Error)
         {
         }
      }

      private function bindNav(name:String,type:String) : void
      {
         var btn:MovieClip = this._skin.getChildByName(name) as MovieClip;
         if(btn == null)
         {
            return;
         }
         btn.buttonMode = true;
         btn.addEventListener(MouseEvent.CLICK,function(e:MouseEvent) : void
         {
            e.stopImmediatePropagation();
            dispatchEvent(new UIEvent(type,true));
         });
         btn.addEventListener(MouseEvent.MOUSE_OVER,this.onButtonOver);
         btn.addEventListener(MouseEvent.MOUSE_OUT,this.onButtonOut);
      }

      private function onSoundClick(e:MouseEvent) : void
      {
         e.stopImmediatePropagation();
         var mc:MovieClip = e.currentTarget as MovieClip;
         if(mc == null)
         {
            return;
         }
         if(MySound.getInstance().bkDisabled)
         {
            mc.gotoAndStop(1);
            MySound.getInstance().bkDisabled = false;
            MySound.getInstance().startByName(SoundCode.MAP);
         }
         else
         {
            mc.gotoAndStop(2);
            MySound.getInstance().bkDisabled = true;
            MySound.getInstance().stop();
         }
      }

      private function onWaveClick(e:MouseEvent) : void
      {
         e.stopImmediatePropagation();
         var mc:MovieClip = e.currentTarget as MovieClip;
         if(mc == null)
         {
            return;
         }
         if(MySound.getInstance().eventDisabled)
         {
            mc.gotoAndStop(1);
            MySound.getInstance().eventDisabled = false;
         }
         else
         {
            mc.gotoAndStop(2);
            MySound.getInstance().eventDisabled = true;
         }
      }

      private function onButtonOver(e:MouseEvent) : void
      {
         var mc:MovieClip = e.currentTarget as MovieClip;
         if(mc == null)
         {
            return;
         }
         if(mc.mouseEnabled)
         {
            mc.scaleX = 1.05;
            mc.scaleY = 1.05;
         }
      }

      private function onButtonOut(e:MouseEvent) : void
      {
         var mc:MovieClip = e.currentTarget as MovieClip;
         if(mc == null)
         {
            return;
         }
         mc.scaleX = 1;
         mc.scaleY = 1;
      }

      public function refresh() : void
      {
         var rm:RoleModel = RoleModel.getInstance();
         if(this._nameTF != null)
         {
            this._nameTF.text = String(rm.roleName) + "  Lv." + rm.level;
         }
         if(this._infoTF != null)
         {
            this._infoTF.text = rm.level + "\n" + rm.reverence + "\n" + rm.money + "\n" + rm.exploit + "\n" + rm.dianka;
         }
         var finished:Vector.<int> = rm.getFinished();
         var i:int = 0;
         while(i < this._levelButtons.length)
         {
            var btn:MovieClip = this._levelButtons[i] as MovieClip;
            if(btn != null)
            {
               var level:int = i + 1;
               var done:Boolean = finished.indexOf(FIRST_GATE_ID + level - 1) != -1;
               var unlocked:Boolean = level == 1 || finished.indexOf(FIRST_GATE_ID + level - 2) != -1 || done;
               // 结算面板未关闭时也先刷新解锁状态，避免 CLOSE_FIGHT 丢失后一直锁着
               var enabled:Boolean = unlocked && !this._inFight;
               Tools.setDisabled(btn,!enabled,false);
               btn.mouseEnabled = enabled;
               btn.mouseChildren = enabled;
               btn.alpha = enabled ? 1 : 0.5;
               btn.buttonMode = enabled;
            }
            i++;
         }
      }

      private function getLevelReq(level:int) : int
      {
         return int(LEVEL_REQ[level - 1]);
      }

      private function getLevelName(level:int) : String
      {
         var n:String = Data.getInstance().getStageName(PART,level);
         if(n == null || n == "" || n == "未知关卡")
         {
            return String(LEVEL_NAME[level - 1]);
         }
         return n;
      }

      private function getLevelDesc(level:int) : String
      {
         return String(LEVEL_DESC[level - 1]);
      }

      private function getRewardStr(level:int) : String
      {
         var award:Object = Data.getInstance().getAward(PART,level);
         if(award == null)
         {
            return "无";
         }
         var s:String = "";
         if(int(award.money) > 0)
         {
            s += int(award.money) + "银子 ";
         }
         if(int(award.exploit) > 0)
         {
            s += int(award.exploit) + "功勋 ";
         }
         if(int(award.reverence) > 0)
         {
            s += int(award.reverence) + "声望 ";
         }
         if(award.proto != null)
         {
            s += "道具 ";
         }
         if(award.recruit != null && award.recruit != "")
         {
            s += "武将[" + award.recruit + "] ";
         }
         if(s == "")
         {
            s = "无";
         }
         return s;
      }

      private function onLevelClick(e:MouseEvent) : void
      {
         e.stopImmediatePropagation();
         // 结算面板关闭事件可能丢失；这里只挡真正进行中的战斗，避免永远点不了下一关
         if(this._inFight)
         {
            return;
         }
         var level:int = int(e.currentTarget["wulinLevel"]);
         if(level < 1 || level > LEVEL_COUNT)
         {
            return;
         }
         var btn:MovieClip = e.currentTarget as MovieClip;
         if(btn != null && !btn.mouseEnabled)
         {
            this.showMsg("请先通关上一关！");
            return;
         }
         var rm:RoleModel = RoleModel.getInstance();
         if(rm.level < this.getLevelReq(level))
         {
            this.showMsg("等级不足！需要 " + this.getLevelReq(level) + " 级才能进入「" + this.getLevelName(level) + "」\n当前等级：" + rm.level + " 级");
            return;
         }
         var data:Object = {};
         data.type = 1;
         data.text = "【" + this.getLevelName(level) + "】\n\n" + this.getLevelDesc(level) +
            "\n\n推荐等级：" + this.getLevelReq(level) +
            "\n首次通关奖励：" + this.getRewardStr(level) +
            "\n\n是否进入战斗？";
         data.fun = function() : void
         {
            startLevel(level);
         };
         dispatchEvent(new UIEvent(UIEvent.MESSAGE,true,data));
      }

      private function onCloseClick(e:MouseEvent) : void
      {
         e.stopImmediatePropagation();
         if(this._inFight)
         {
            this.showMsg("战斗尚未结束，无法离开。");
            return;
         }
         this.close();
      }

      public function close() : void
      {
         this._inFight = false;
         this._awaitingResult = false;
         this.removeCapture();
         if(this.parent != null)
         {
            this.parent.removeChild(this);
         }
      }

      private function showMsg(text:String) : void
      {
         dispatchEvent(new UIEvent(UIEvent.MESSAGE,true,{"type":0,"text":text}));
      }

      public function drawMask() : void
      {
         if(stage == null)
         {
            return;
         }
         graphics.clear();
         var p:Point = globalToLocal(new Point());
         graphics.beginFill(0,0.45);
         graphics.drawRect(p.x,p.y,stage.stageWidth,stage.stageHeight);
         graphics.endFill();
      }

      private function isBossLevel(level:int) : Boolean
      {
         return BOSS_LEVELS.indexOf(level) != -1;
      }

      /**
       * game.Fight / WulinBossGate 的站位只有 POS0~POS4（战车另用 TS_POS），
       * 超过 5 个非战车单位会在第 6 个摆位时抛异常，导致战斗只初始化一半。
       * 这里兜底裁掉多余单位，防止关卡数据写多时整场战斗不可操作。
       */
      private function limitArmy(param1:Vector.<ArmyInfo>) : Vector.<ArmyInfo>
      {
         if(param1 == null)
         {
            return param1;
         }
         var count:int = 0;
         var i:int = 0;
         while(i < param1.length)
         {
            if(param1[i] != null && param1[i].type != Type.TOUSHICHE)
            {
               count++;
               if(count > 5)
               {
                  param1.splice(i,1);
                  continue;
               }
            }
            i++;
         }
         return param1;
      }

      private function countFighters(param1:Vector.<ArmyInfo>) : int
      {
         var count:int = 0;
         var i:int = 0;
         while(i < param1.length)
         {
            if(param1[i] != null && param1[i].type != Type.TOUSHICHE)
            {
               count++;
            }
            i++;
         }
         return count;
      }

      /**
       * 兜底：关卡数据可能引用不存在的造型类（例如 general_12_1 写 evolution=3
       * 会去找不存在的 generalSkin_12_1），武将构造时 new null() 抛异常会让
       * initView 中断，表现为不能操作、没有头像。这里在战斗前退回可用造型。
       */
      private function sanitizeSkins(param1:Vector.<ArmyInfo>) : void
      {
         if(param1 == null)
         {
            return;
         }
         var i:int = 0;
         while(i < param1.length)
         {
            var info:ArmyInfo = param1[i];
            if(info != null && info.skin != null && info.skin != "")
            {
               var cls:Class = null;
               try
               {
                  cls = ApplicationDomain.currentDomain.getDefinition(info.skin) as Class;
               }
               catch(e1:Error)
               {
                  cls = null;
               }
               if(cls == null)
               {
                  var fallback:String = info.skin;
                  if(fallback.length >= 2 && fallback.substr(fallback.length - 2) == "_1")
                  {
                     fallback = fallback.substring(0,fallback.length - 2) + "_0";
                  }
                  try
                  {
                     cls = ApplicationDomain.currentDomain.getDefinition(fallback) as Class;
                  }
                  catch(e2:Error)
                  {
                     cls = null;
                  }
                  if(cls == null)
                  {
                     fallback = "generalSkin_9_0";
                  }
                  info.skin = fallback;
               }
            }
            i++;
         }
      }

      public function startLevel(level:int) : void
      {
         if(this._inFight || level < 1 || level > LEVEL_COUNT)
         {
            return;
         }
         var rm:RoleModel = RoleModel.getInstance();
         var myArmy:Vector.<ArmyInfo> = rm.getChooseSoldiers();
         if(myArmy == null || myArmy.length == 0)
         {
            this.showMsg("请先在布阵中选择上阵武将");
            return;
         }
         var enemyArmy:Vector.<ArmyInfo> = Data.getInstance().getGateArmys(PART,level);
         if(enemyArmy == null || enemyArmy.length == 0)
         {
            this.showMsg("敌方军队数据加载失败");
            return;
         }
         if(this.countFighters(myArmy) > 5)
         {
            this.showMsg("最多只能上阵 5 名武将（战车不占位置），请在布阵中调整。");
            return;
         }
         enemyArmy = this.limitArmy(enemyArmy);
         this.sanitizeSkins(enemyArmy);

         this._fightLevel = level;
         this._inFight = true;
         this.refresh();
         rm.status = RoleStatus.GUANKA;

         try
         {
            if(this.isBossLevel(level))
            {
               this._bossGate = new WulinBossGate(myArmy,enemyArmy,PART,level);
               this._bossGate.addEventListener(FightEvent.FIGHT_COMPLETE,this.onBossComplete);
               this._ui.addChild(this._bossGate);
               MySound.getInstance().startByName(SoundCode.XIONGNU_SOUND1);
            }
            else
            {
               this.addFightBackground();
               this._fight = new Fight(myArmy,enemyArmy,1,false);
               this._fight.addEventListener(FightEvent.FIGHT_COMPLETE,this.onFightComplete);
               this._ui.addChild(this._fight);
               try
               {
                  this._fight.setPartAndLevel(PART,level);
               }
               catch(e:Error)
               {
               }
               this._fight.startDirect();
               MySound.getInstance().startByName(SoundCode.P2PFIGHT);
            }
         }
         catch(err:Error)
         {
            this.removeFightVisuals();
            MySound.getInstance().stop();
            this._inFight = false;
            this._awaitingResult = false;
            rm.status = RoleStatus.DANJI;
            this.refresh();
            this.showMsg("战斗启动失败：" + err.message);
         }
      }

      private function addFightBackground() : void
      {
         try
         {
            var cls:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.FUBEN_STAGE4) as Class;
            if(cls == null)
            {
               return;
            }
            this._fightBg = new cls() as Sprite;
            this._fightBg.x = this._ui.stage.stageWidth / 2;
            this._fightBg.y = this._ui.stage.stageHeight / 2;
            this._ui.addChild(this._fightBg);
         }
         catch(e:Error)
         {
            this._fightBg = null;
         }
      }

      private function onFightComplete(e:FightEvent) : void
      {
         e.stopPropagation();
         this.finishFight(String(e.data.flag),Number(e.data.m),Number(e.data.n));
      }

      private function onBossComplete(e:FightEvent) : void
      {
         e.stopPropagation();
         this.finishFight(String(e.data.flag),Number(e.data.m),Number(e.data.n));
      }

      private function finishFight(flag:String,m:Number,n:Number) : void
      {
         this.removeFightVisuals();
         MySound.getInstance().stop();
         RoleModel.getInstance().status = RoleStatus.DANJI;
         var level:int = this._fightLevel;
         if(flag == "win")
         {
            // 本地先记通关，保证回到地图立刻解锁下一关；服务端返回后会再次以服务端进度为准
            RoleModel.getInstance().addFinished(FIRST_GATE_ID + level - 1);
         }
         this._inFight = false;
         this._awaitingResult = true;
         this.refresh();

         var stageName:String = this.getLevelName(level);
         var info:Object = {};
         info.p2p = false;
         info.part = PART;
         info.level = level;
         info.stageName = stageName;
         if(flag == "win")
         {
            info.flag = "win";
            info.money = Logic.getMoneyByFight(m,n);
            info.exploit = Logic.getExploitByFight(m,n);
            info.reverence = Logic.getReverenceByFight(m,n);
            this._ui.showFightResult(info);
            this.sendResult(level,m,n);
         }
         else
         {
            info.flag = "lost";
            info.money = 0;
            info.exploit = 0;
            info.reverence = 0;
            this._ui.showFightResult(info);
            MySound.getInstance().startEventSoundByName(SoundCode.LOST);
         }
      }

      private function removeFightVisuals() : void
      {
         if(this._fight != null)
         {
            this._fight.removeEventListener(FightEvent.FIGHT_COMPLETE,this.onFightComplete);
            try
            {
               this._fight.clear();
            }
            catch(e1:Error)
            {
            }
            if(this._fight.parent != null)
            {
               this._fight.parent.removeChild(this._fight);
            }
            this._fight = null;
         }
         if(this._bossGate != null)
         {
            this._bossGate.removeEventListener(FightEvent.FIGHT_COMPLETE,this.onBossComplete);
            try
            {
               this._bossGate.clear();
            }
            catch(e2:Error)
            {
            }
            if(this._bossGate.parent != null)
            {
               this._bossGate.parent.removeChild(this._bossGate);
            }
            this._bossGate = null;
         }
         if(this._fightBg != null)
         {
            if(this._fightBg.parent != null)
            {
               this._fightBg.parent.removeChild(this._fightBg);
            }
            this._fightBg = null;
         }
      }

      private function sendResult(level:int,m:Number,n:Number) : void
      {
         var req:Object = {};
         req.head = Head.HTTP_NEW_FIGHT_RESULT;
         req.agent = Config.AGENT;
         req.ver = Config.VER;
         req.token = Config.token;
         req.roleID = RoleModel.getInstance().roleID;
         req.userID = RoleModel.getInstance().userID;
         req.part = PART;
         req.level = level;
         req.m = m;
         req.n = n;
         req.mask = true;
         AESController.getInstance().sendJSON(req,function(res:Object) : void
         {
            onResultResponse(res,level);
         });
      }

      private function onResultResponse(res:Object,level:int) : void
      {
         if(res == null)
         {
            return;
         }
         if(res.success != true)
         {
            this.showMsg(String(res.message == null ? "战斗结算失败" : res.message));
            return;
         }
         var rm:RoleModel = RoleModel.getInstance();
         var data:Object = res.data;
         rm.money = int(data.m);
         rm.exploit = int(data.e);
         rm.reverence = int(data.r);
         if(data.finished != null)
         {
            rm.importFinished(String(data.finished));
         }

         var addition:Object = null;
         if(data.award != null)
         {
            addition = {};
            addition.money = int(data.award.money);
            addition.exploit = int(data.award.exploit);
            addition.reverence = int(data.award.reverence);
            if(data.award.soldier != null && data.award.soldier.length > 0)
            {
               addition.soldier = [];
               var i:int = 0;
               while(i < data.award.soldier.length)
               {
                  var g:Object = data.award.soldier[i];
                  var army:ArmyInfo = Data.getInstance().getArmyInfo(String(g.code),1);
                  if(army != null)
                  {
                     army.id = int(g.id);
                     rm.addSoldier(army);
                     addition.soldier.push(String(g.code));
                  }
                  i++;
               }
            }
            if(data.award.item != null && data.award.item.length > 0)
            {
               addition.proto = [];
               var j:int = 0;
               while(j < data.award.item.length)
               {
                  var it:Object = data.award.item[j];
                  rm.modiBagItem(int(it.id),String(it.code),int(it.count));
                  addition.proto.push(String(it.code) + ":" + int(it.count));
                  j++;
               }
            }
            addition.recruit = data.award.recruit;
         }

         rm.throttleSave();
         // 服务端已确认结算，解除等待标志；不再依赖结果面板的 CLOSE_FIGHT
         this._awaitingResult = false;
         this.refresh();

         if(this._ui != null && this._ui.fightResult())
         {
            var info:Object = {};
            info.p2p = false;
            info.part = PART;
            info.level = level;
            info.flag = "win";
            info.stageName = this.getLevelName(level);
            info.money = int(data.money);
            info.exploit = int(data.exploit);
            info.reverence = int(data.reverence);
            if(addition != null)
            {
               info.addition = addition;
            }
            this._ui.showFightResult(info);
         }
      }

      private function initCapture() : void
      {
         if(this._captureAdded || this._ui == null)
         {
            return;
         }
         this._ui.addEventListener(UIEvent.OPEN_STAGE,this.onCaptureOpenStage,true,0,false);
         this._ui.addEventListener(FightEvent.CLOSE_FIGHT,this.onCaptureCloseFight,true,0,false);
         this._captureAdded = true;
      }

      private function removeCapture() : void
      {
         if(!this._captureAdded || this._ui == null)
         {
            return;
         }
         this._ui.removeEventListener(UIEvent.OPEN_STAGE,this.onCaptureOpenStage,true);
         this._ui.removeEventListener(FightEvent.CLOSE_FIGHT,this.onCaptureCloseFight,true);
         this._captureAdded = false;
      }

      private function onCaptureOpenStage(e:UIEvent) : void
      {
         if(e.data != null && int(e.data.part) == PART && (this._awaitingResult || this._inFight))
         {
            e.stopPropagation();
         }
      }

      private function onCaptureCloseFight(e:FightEvent) : void
      {
         if(!this._awaitingResult)
         {
            return;
         }
         e.stopPropagation();
         this._awaitingResult = false;
         this.refresh();
      }
   }
}
