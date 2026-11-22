package game.fuben
{
   import com.greensock.TweenLite;
   import com.greensock.easing.Elastic;
   import com.iflashigame.utils.Tools;
   import flash.display.Bitmap;
   import flash.display.BitmapData;
   import flash.display.Graphics;
   import flash.display.MovieClip;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.KeyboardEvent;
   import flash.events.MouseEvent;
   import flash.events.TimerEvent;
   import flash.filters.GlowFilter;
   import flash.geom.Point;
   import flash.geom.Rectangle;
   import flash.system.ApplicationDomain;
   import flash.text.TextField;
   import flash.text.TextFormat;
   import flash.ui.Mouse;
   import flash.utils.Timer;
   import game.Config;
   import game.Data;
   import game.Logic;
   import game.ai.AI;
   import game.ai.XiongnuAI;
   import game.display.Boss;
   import game.display.QianggongSoldier;
   import game.display.WandaoSoldier;
   import game.display.JiantaSoldier;
   import game.fuben.XiongnuConfig;
   import game.ai.IAI;
   import game.ai.SmartAttack;
   import game.display.AbstractSoldier;
   import game.display.Gunner;
   import game.display.IWorld;
   import game.display.Junzhu;
   import game.display.JiantaWeapon;
   import game.display.QianggongWeapon;
   import game.display.Saber;
   import game.display.Shooter;
   import game.display.StoneWeapon;
   import game.display.Weapon;
   import game.events.ConEvent;
   import game.events.FightEvent;
   import game.events.SoldierEvent;
   import game.events.UIEvent;
   import game.events.WeaponEvent;
   import game.model.ArmyInfo;
   import game.model.RoleModel;
   import game.model.Type;
   import game.ui.AngleController;
   import game.ui.ConType;
   import game.ui.FightUI;
   import game.ui.NumTips;
   import game.ui.SkinCode;
   
   public class WulinBossGate extends Sprite implements IAI, IWorld
   {
      
      private static const TS_POS:Point = new Point(50,340);
      
      private static const POS0:Point = new Point(140,315);
      
      private static const POS1:Point = new Point(180,340);
      
      private static const POS2:Point = new Point(220,365);
      
      private static const POS3:Point = new Point(180,390);
      
      private static const POS4:Point = new Point(140,415);
      
      public static const MERIC:int = 30;

      // Boss 对玩家武将的伤害按目标最大生命比例结算（参考原版 XiongnuConfig）
      private static const BOSS_AOE_RATE:Number = 0.05;
      private static const BOSS_HIT_RATE:Number = 0.03;
      
      private var _leftArmy:Vector.<ArmyInfo>;
      
      private var _rightArmy:Vector.<ArmyInfo>;
      
      private var _direct:int;
      
      private var _delay:Number = 0;
      
      private var _timer:Timer;
      
      private var _leftSoldiers:Array;
      
      private var _rightSoldiers:Array;
      
      private var _bk:MovieClip;
      
      private var _yuanchengCon:AngleController;
      
      private var _miaozhunjing:MovieClip;
      
      private var _tipsLayer:NumTips;
      
      private var _isOver:Boolean;
      
      private var _currentSoldier:AbstractSoldier;
      
      private var _ai:Object;
      
      private var _ammo:String = "";
      
      private var _title:Bitmap;
      
      private var _gridContainer:Sprite;
      
      private var _currentGrid:MovieClip;
      
      private var _lockedEnemy:AbstractSoldier;
      
      private var _date:Number;
      
      private var _biansu:int = 0;
      
      private var _fightUI:FightUI;
      
      private var _ammoTips:MovieClip;
      
      private var _part:int;
      
      private var _level:int;
      
      private var _playerImage:Sprite;
      
      public function WulinBossGate(param1:Vector.<ArmyInfo>, param2:Vector.<ArmyInfo>, param3:int, param4:int)
      {
         super();
         this._leftArmy = param1.sort(this.compare);
         this._rightArmy = param2.sort(this.compare);
         this._part = param3;
         this._level = param4;
         this._direct = 1;
         this.scaleBossArmy();
         if(stage != null)
         {
            this.addToStageHandler(null);
         }
         else
         {
            addEventListener(Event.ADDED_TO_STAGE,this.addToStageHandler);
         }
      }
      
      private function compare(param1:ArmyInfo, param2:ArmyInfo) : Number
      {
         if(param1.sortFlag < param2.sortFlag)
         {
            return -1;
         }
         if(param1.sortFlag > param2.sortFlag)
         {
            return 1;
         }
         return 0;
      }

      /**
       * 副本 BOSS 按玩家军队强度缩放：stage.xml 里 general_13_1 没有 13_0 成长系数，
       * 固定等级下 HP 只有 1000、攻击 300，会被玩家一刀秒且打不动玩家。
       */
      private function scaleBossArmy() : void
      {
         var n:int = int(this._leftArmy.length);
         if(n <= 0 || this._rightArmy == null || this._rightArmy.length == 0)
         {
            return;
         }
         var hpSum:Number = 0;
         var atkSum:Number = 0;
         var defSum:Number = 0;
         var i:int = 0;
         while(i < n)
         {
            hpSum += this._leftArmy[i].fullHp;
            atkSum += this._leftArmy[i].attack;
            defSum += this._leftArmy[i].defense;
            i++;
         }
         var hpMul:Number = this._level >= 10 ? 10 : 5;
         var atkMul:Number = this._level >= 10 ? 1.5 : 1.15;
         var j:int = 0;
         while(j < this._rightArmy.length)
         {
            var info:ArmyInfo = this._rightArmy[j];
            if(info.type == Type.BOSS)
            {
               info.hp = int(hpSum * hpMul);
               info.baseDefense = int(defSum / n);
               info.baseAttack = int(atkSum / n * atkMul);
            }
            j++;
         }
      }
      
      private function addToStageHandler(param1:Event) : void
      {
         removeEventListener(Event.ADDED_TO_STAGE,this.addToStageHandler);
         this.initView();
      }
      
      private function initView() : void
      {
         this.createBK();
         this.createLeftArmy();
         this.createRightArmy();
         this.createGIcon();
         this.createController();
         this.createTipsLayer();
         this.createAmmoTips();
         this.creatGrid();
         this.createTitle();
         this.createPlayerImage();
         this.initEvent();
         this._ai = new XiongnuAI(this,5000,-1,new XiongnuConfig());
         this._ai.startAI();
         this._date = new Date().getTime();
         this._timer = new Timer(Config.NORMAL);
         this._timer.addEventListener(TimerEvent.TIMER,this.speedCheckHandler);
         this._timer.start();
      }
      
      private function createBK() : void
      {
         var _loc1_:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.FIGHT_STAGE) as Class;
         this._bk = new _loc1_() as MovieClip;
         this._bk.x = stage.stageWidth / 2;
         this._bk.y = stage.stageHeight / 2;
         addChild(this._bk);
      }
      
      private function createLeftArmy() : void
      {
         var _loc1_:int = 0;
         this._leftSoldiers = [];
         var _loc2_:int = int(this._leftArmy.length);
         var _loc3_:int = 0;
         while(_loc3_ < _loc2_)
         {
            var _loc4_:AbstractSoldier = this.armyFactory(this._leftArmy[_loc3_],1,true);
            if(_loc4_.type == Type.TOUSHICHE)
            {
               _loc4_.x = TS_POS.x;
               _loc4_.y = TS_POS.y;
            }
            else
            {
               _loc4_.x = WulinBossGate["POS" + _loc1_].x;
               _loc4_.y = WulinBossGate["POS" + _loc1_].y;
               _loc1_++;
            }
            addChild(_loc4_);
            this._leftSoldiers.push(_loc4_);
            _loc3_++;
         }
      }
      
      private function createRightArmy() : void
      {
         var _loc1_:int = 0;
         this._rightSoldiers = [];
         var _loc2_:int = int(this._rightArmy.length);
         var _loc3_:int = int(this._leftArmy.length);
         var _loc4_:int = 0;
         while(_loc4_ < _loc2_)
         {
            var _loc5_:AbstractSoldier = this.armyFactory(this._rightArmy[_loc4_],-1,false);
            if(_loc5_.type == Type.TOUSHICHE)
            {
               _loc5_.x = 770 - TS_POS.x;
               _loc5_.y = TS_POS.y;
            }
            else
            {
               _loc5_.x = 770 - WulinBossGate["POS" + _loc1_].x;
               _loc5_.y = WulinBossGate["POS" + _loc1_].y;
               _loc1_++;
            }
            if(_loc4_ < _loc3_)
            {
               addChildAt(_loc5_,getChildIndex(this._leftSoldiers[_loc4_]));
            }
            else
            {
               addChild(_loc5_);
            }
            this._rightSoldiers.push(_loc5_);
            _loc4_++;
         }
      }
      
      private function armyFactory(param1:ArmyInfo, param2:int, param3:Boolean) : AbstractSoldier
      {
         switch(param1.type)
         {
            case Type.TOUSHICHE:
               return new Gunner(param1.clone(),param2,param3,this);
            case Type.QIBING:
               return new Saber(param1.clone(),param2,param3,this);
            case Type.JIANTABING:
               return new JiantaSoldier(param1.clone(),param2,param3,this);
            case Type.QIANGGONGBING:
               return new QianggongSoldier(param1.clone(),param2,param3,this);
            case Type.WANDAOBING:
               return new WandaoSoldier(param1.clone(),param2,param3,this);
            case Type.BOSS:
               return new Boss(param1.clone(),param2,param3,this);
            case Type.JUNZHU:
               return new Junzhu(param1.clone(),param2,param3,this);
            default:
               return new Shooter(param1.clone(),param2,param3,this);
         }
      }

      private function createGIcon() : void
      {
         this._fightUI = new FightUI();
         this._fightUI.y = 447;
         addChild(this._fightUI);
         this._fightUI.initData(this._leftArmy);
      }
      
      private function createController() : void
      {
         this._yuanchengCon = new AngleController(SkinCode.ANGLE_CON);
         this._yuanchengCon.visible = false;
         addChild(this._yuanchengCon);
         var _loc1_:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.MIAOZHUN_CON) as Class;
         this._miaozhunjing = new _loc1_() as MovieClip;
         this._miaozhunjing.mouseChildren = false;
         this._miaozhunjing.mouseEnabled = false;
         this._miaozhunjing.visible = false;
         addChild(this._miaozhunjing);
      }
      
      private function createTipsLayer() : void
      {
         this._tipsLayer = new NumTips();
         addChild(this._tipsLayer);
      }
      
      private function createAmmoTips() : void
      {
         var _loc1_:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.AMMO_TIPS) as Class;
         this._ammoTips = new _loc1_() as MovieClip;
         this._ammoTips.visible = false;
         this._tipsLayer.addChild(this._ammoTips);
      }
      
      private function creatGrid() : void
      {
         this._gridContainer = new Sprite();
         this._gridContainer.graphics.beginFill(0,0.4);
         this._gridContainer.graphics.drawRoundRect(0,0,290,38,4,4);
         this._gridContainer.graphics.endFill();
         addChild(this._gridContainer);
         var _loc1_:Class = ApplicationDomain.currentDomain.getDefinition(SkinCode.ICON_GRID) as Class;
         var _loc2_:int = 1;
         while(_loc2_ <= 8)
         {
            var _loc3_:MovieClip = new _loc1_() as MovieClip;
            _loc3_.buttonMode = true;
            _loc3_.name = "grid" + _loc2_;
            var _loc4_:Class = ApplicationDomain.currentDomain.getDefinition("proto_2_" + _loc2_) as Class;
            var _loc5_:Bitmap = new Bitmap(new _loc4_() as BitmapData);
            _loc5_.x = 2;
            _loc5_.y = 2;
            _loc3_.addChildAt(_loc5_,0);
            _loc3_.x = 2 + (_loc2_ - 1) * (_loc3_.width + 2);
            _loc3_.y = 2;
            _loc3_.code = "proto_2_" + _loc2_;
            this._gridContainer.addChild(_loc3_);
            var _loc6_:Boolean = RoleModel.getInstance().findBagItem("proto_2_" + _loc2_);
            _loc3_.countTF.text = RoleModel.getInstance().getBagItemCount("proto_2_" + _loc2_);
            _loc3_.sanjiao.visible = false;
            Tools.setDisabled(_loc3_,!_loc6_);
            _loc3_.countTF.mouseEnabled = false;
            _loc3_.addEventListener(MouseEvent.MOUSE_OVER,this.onGridOverHandler);
            _loc3_.addEventListener(MouseEvent.MOUSE_OUT,this.onGridOutHandler);
            _loc2_++;
         }
         this._gridContainer.y = 460;
         this._gridContainer.x = (770 - this._gridContainer.width) / 2;
         this._gridContainer.addEventListener(MouseEvent.CLICK,this.onGridClickHandler);
      }
      
      private function onGridOverHandler(param1:MouseEvent) : void
      {
         var _loc2_:MovieClip = param1.target as MovieClip;
         var _loc3_:Array = _loc2_.filters || [];
         _loc3_.push(new GlowFilter(16763955,1,2,2,100));
         _loc2_.filters = _loc3_;
         var _loc4_:String = _loc2_.code;
         var _loc5_:String = Data.getInstance().getAttributes("proto",_loc4_,"name");
         var _loc6_:int = Data.getInstance().getAttributes("proto",_loc4_,"type");
         var _loc7_:String = Data.getInstance().getAttributes("proto",_loc4_,"desc");
         var _loc8_:String = "<font color=\'#e5ce10\'>名称：</font>" + _loc5_ + "\n";
         _loc8_ += "<font color=\'#e5ce10\'>类别：</font>" + (_loc6_ == 1 ? "进化道具" : "战车弹药") + "\n";
         _loc8_ += "<font color=\'#e5ce10\'>说明：</font>" + _loc7_ + "\n";
         dispatchEvent(new UIEvent(UIEvent.SHOW_TIPS,true,{
            "htmlText":_loc8_,
            "type":3,
            "width":150,
            "height":70
         }));
      }
      
      private function onGridOutHandler(param1:MouseEvent) : void
      {
         var _loc2_:MovieClip = param1.target as MovieClip;
         var _loc3_:Array = _loc2_.filters;
         var _loc4_:int = 0;
         while(_loc4_ < _loc3_.length)
         {
            if(_loc3_[_loc4_] is GlowFilter)
            {
               _loc3_.splice(_loc4_,1);
               break;
            }
            _loc4_++;
         }
         _loc2_.filters = _loc3_;
         dispatchEvent(new UIEvent(UIEvent.HIDE_TIPS,true));
      }
      
      private function onGridClickHandler(param1:MouseEvent) : void
      {
         param1.stopImmediatePropagation();
         if(!(param1.target is MovieClip))
         {
            return;
         }
         if(this._currentGrid != null)
         {
            this._currentGrid.sanjiao.visible = false;
         }
         this._currentGrid = param1.target as MovieClip;
         this._currentGrid.sanjiao.visible = true;
         var _loc2_:String = param1.target.code;
         this._ammo = RoleModel.getInstance().findBagItem(_loc2_) ? _loc2_ : "";
      }
      
      private function createTitle() : void
      {
         var _loc2_:Class;
         var _loc1_:int = Data.getInstance().getStageID(this._part,this._level);
         try
         {
            _loc2_ = ApplicationDomain.currentDomain.getDefinition("title_" + _loc1_) as Class;
            this._title = new Bitmap(new _loc2_() as BitmapData);
            addChild(this._title);
            this._title.x = (stage.stageWidth - this._title.width) / 2;
            this._title.y = 30;
         }
         catch(e:Error)
         {
         }
      }
      
      private function createPlayerImage() : void
      {
         this._playerImage = new Sprite();
         this._playerImage.mouseChildren = false;
         this._playerImage.mouseEnabled = false;
         addChild(this._playerImage);
         this._playerImage.graphics.beginFill(0,0.3);
         this._playerImage.graphics.drawRoundRect(4,4,160,60,12,12);
         this._playerImage.graphics.drawRoundRect(770 - 164,4,160,60,12,12);
         this._playerImage.graphics.endFill();
         var _loc1_:Class = ApplicationDomain.currentDomain.getDefinition("image" + RoleModel.getInstance().imageID) as Class;
         var _loc2_:MovieClip = new _loc1_() as MovieClip;
         _loc2_.scaleX = 0.5;
         _loc2_.scaleY = 0.5;
         _loc2_.gotoAndStop(2);
         _loc2_.x = 8;
         _loc2_.y = 8;
         this._playerImage.addChild(_loc2_);
         var _loc3_:TextField = new TextField();
         _loc3_.selectable = false;
         _loc3_.multiline = true;
         var _loc4_:TextFormat = new TextFormat();
         _loc4_.color = 16777215;
         _loc4_.leading = 2;
         _loc3_.defaultTextFormat = _loc4_;
         _loc3_.filters = [new GlowFilter(0,1,2,2,100)];
         _loc3_.text = RoleModel.getInstance().roleName + "\nLv：" + RoleModel.getInstance().level;
         _loc3_.width = _loc3_.textWidth + 5;
         _loc3_.x = _loc2_.x + _loc2_.width + 3;
         _loc3_.y = 12;
         this._playerImage.addChild(_loc3_);
         var _loc5_:int = 0;
         var _loc6_:int = int(this._rightArmy.length);
         var _loc7_:int = 0;
         while(_loc7_ < _loc6_)
         {
            _loc5_ += this._rightArmy[_loc7_].level;
            _loc7_++;
         }
         var _loc8_:int = _loc6_ > 0 ? int(_loc5_ / _loc6_) : 1;
         var _loc9_:Class = ApplicationDomain.currentDomain.getDefinition("image1") as Class;
         var _loc10_:MovieClip = new _loc9_() as MovieClip;
         _loc10_.scaleX = -0.5;
         _loc10_.scaleY = 0.5;
         _loc10_.gotoAndStop(2);
         _loc10_.x = 770 - 8;
         _loc10_.y = 8;
         this._playerImage.addChild(_loc10_);
         var _loc11_:TextField = new TextField();
         _loc11_.selectable = false;
         _loc11_.multiline = true;
         var _loc12_:TextFormat = new TextFormat();
         _loc12_.color = 16711680;
         _loc12_.leading = 2;
         _loc12_.align = "right";
         _loc11_.defaultTextFormat = _loc12_;
         _loc11_.filters = [new GlowFilter(0,1,2,2,100)];
         _loc11_.text = "敌方军队\nLv：" + _loc8_;
         _loc11_.width = 80;
         _loc11_.x = _loc10_.x - _loc10_.width - 3 - 80;
         _loc11_.y = 12;
         this._playerImage.addChild(_loc11_);
      }
      
      private function initEvent() : void
      {
         addEventListener(SoldierEvent.SELECTED,this.onSoldierSelectedHandler);
         addEventListener(SoldierEvent.ENEMY_SELECTED,this.onEnemySelectedHandler);
         addEventListener(SoldierEvent.SMART_ATTACK,this.smartAttackHandler);
         addEventListener(MouseEvent.CLICK,this.onMouseClickHandler);
         addEventListener(ConEvent.SELECT_SOLDIER,this.onSelectSoldierHandler);
         addEventListener(ConEvent.CREATE_MIAOZHUNJING,this.createMiaozhunjingHandler);
         addEventListener(ConEvent.FIRE,this.conFireHandler);
         addEventListener(SoldierEvent.ZHAOHUAN,this.onSoldierZhaohuanHandler);
         if(stage != null)
         {
            stage.addEventListener(SoldierEvent.RETREAT,this.onRetreatHandler);
            stage.addEventListener(KeyboardEvent.KEY_DOWN,this.onKeydownHandler);
            stage.addEventListener(MouseEvent.CLICK,this.onStageClick,true);
         }
         this.initUnInteractiveEvent();
      }
      
      private function initUnInteractiveEvent() : void
      {
         addEventListener(SoldierEvent.FILL_COMPLETE,this.onSoldierFillCompleteHandler);
         addEventListener(SoldierEvent.FIRE_COMPLETE,this.onSoldierFireCompleteHandler);
         addEventListener(SoldierEvent.BEHURT,this.onSoldierBehurtHandler);
         addEventListener(SoldierEvent.SHANBI,this.onSoldierShanbiHandler);
         addEventListener(SoldierEvent.HUIFU,this.onSoldierHuifuHandler);
         addEventListener(SoldierEvent.DEAD,this.onSoldierDeadHandler);
         addEventListener(SoldierEvent.DEAD_COMPLETE,this.onSoldierDeadCompleteHandler);
      }
      
      private function onSoldierSelectedHandler(param1:SoldierEvent) : void
      {
         if(this._miaozhunjing.visible)
         {
            Mouse.show();
            Mouse.prototype.isHide = false;
            Mouse.prototype.canFire = false;
            this._miaozhunjing.visible = false;
         }
         if(this._currentSoldier)
         {
            this._currentSoldier.setUnSelected();
            this._currentSoldier.setNameVisible(true);
         }
         this.resetController();
         this.setCurrentSoldier(param1.target as AbstractSoldier);
      }
      
      private function onEnemySelectedHandler(param1:SoldierEvent) : void
      {
         if(this._miaozhunjing.visible)
         {
            Mouse.show();
            Mouse.prototype.isHide = false;
            this._miaozhunjing.visible = false;
            if(Mouse.prototype.canFire && this._currentSoldier && !this._currentSoldier.isDead && !this._currentSoldier.fireing)
            {
               this._currentSoldier.stand();
               dispatchEvent(new ConEvent(ConEvent.FIRE,false,{
                  "type":ConType.JINCHENG,
                  "target":param1.target
               }));
            }
            Mouse.prototype.canFire = false;
         }
      }
      
      private function onSelectSoldierHandler(param1:ConEvent) : void
      {
         if(this._miaozhunjing.visible)
         {
            Mouse.show();
            Mouse.prototype.isHide = false;
            Mouse.prototype.canFire = false;
            this._miaozhunjing.visible = false;
         }
         if(this._currentSoldier)
         {
            this._currentSoldier.setUnSelected();
            this._currentSoldier.setNameVisible(true);
         }
         this.resetController();
         this.setCurrentSoldier(this.selectSoldier(param1.data.id,param1.data.code));
      }
      
      private function smartAttackHandler(param1:SoldierEvent) : void
      {
         this.onMouseClickHandler(null);
         SmartAttack.makeAI(param1.target as AbstractSoldier,this);
      }
      
      private function onMouseClickHandler(param1:MouseEvent) : void
      {
         if(this._currentSoldier && !this._currentSoldier.isDead && !this._currentSoldier.fireing && this._currentSoldier.type != Type.TOUSHICHE)
         {
            var _loc2_:Number = Math.abs(mouseX - this._currentSoldier.x);
            this._currentSoldier.stand();
            if(mouseX < this._currentSoldier.x)
            {
               this._currentSoldier.goLeft(_loc2_);
            }
            else
            {
               this._currentSoldier.goRight(_loc2_);
            }
         }
         this.clearCurrentSoldier();
         this.resetController();
         Mouse.show();
         Mouse.prototype.isHide = false;
         Mouse.prototype.canFire = false;
         this._miaozhunjing.visible = false;
      }
      
      private function createMiaozhunjingHandler(param1:ConEvent) : void
      {
         this._miaozhunjing.addEventListener(Event.ENTER_FRAME,this.onMiaozhunjingEnterFrameHandler);
         addEventListener(SoldierEvent.ENEMY_LOCKED,this.enemyLockHandler);
         addEventListener(SoldierEvent.ENEMY_UNLOCKED,this.enemyUnlockHandler);
         this._miaozhunjing.visible = true;
         Mouse.prototype.isHide = true;
         Mouse.hide();
      }
      
      private function enemyLockHandler(param1:SoldierEvent) : void
      {
         this._lockedEnemy = param1.target as AbstractSoldier;
      }
      
      private function enemyUnlockHandler(param1:SoldierEvent) : void
      {
         this._lockedEnemy = null;
      }
      
      private function onMiaozhunjingEnterFrameHandler(param1:Event) : void
      {
         this._miaozhunjing.x = mouseX;
         this._miaozhunjing.y = mouseY;
         if(this._lockedEnemy && this._currentSoldier)
         {
            this._miaozhunjing.gotoAndStop(3);
            Mouse.prototype.canFire = true;
         }
         else
         {
            this._miaozhunjing.gotoAndStop(1);
            Mouse.prototype.canFire = false;
         }
      }
      
      private function conFireHandler(param1:ConEvent) : void
      {
         if(!this._currentSoldier || this._currentSoldier.isDead)
         {
            return;
         }
         switch(param1.data.type)
         {
            case ConType.YUANCHENG:
               this._currentSoldier.fire({
                  "angle":param1.data.angle,
                  "power":param1.data.power
               });
               break;
            case ConType.JINCHENG:
               this._currentSoldier.fire2({"target":param1.data.target});
         }
         this.clearCurrentSoldier();
         this.resetController();
      }
      
      private function resetController() : void
      {
         this._yuanchengCon.stopBar();
         this._yuanchengCon.visible = false;
         this._yuanchengCon.setEnabled(true);
         this._miaozhunjing.removeEventListener(Event.ENTER_FRAME,this.onMiaozhunjingEnterFrameHandler);
         this._miaozhunjing.gotoAndStop(1);
         removeEventListener(SoldierEvent.ENEMY_LOCKED,this.enemyLockHandler);
         removeEventListener(SoldierEvent.ENEMY_UNLOCKED,this.enemyUnlockHandler);
         this._lockedEnemy = null;
      }
      
      private function clearCurrentSoldier() : void
      {
         if(this._currentSoldier)
         {
            this._currentSoldier.setUnSelected();
            this._currentSoldier.setNameVisible(true);
            this._currentSoldier = null;
         }
      }
      
      private function setCurrentSoldier(param1:AbstractSoldier) : void
      {
         if(!param1 || param1.fireing || param1.isDead)
         {
            return;
         }
         this._currentSoldier = param1;
         param1.setSelected();
         param1.setNameVisible(false);
         switch(param1.type)
         {
            case Type.TOUSHICHE:
               if(param1.isPlayer && this._ammo == "")
               {
                  this.setAmmoTips(param1);
                  return;
               }
               this._yuanchengCon.visible = true;
               this._yuanchengCon.x = param1.x;
               this._yuanchengCon.y = param1.y - param1.long - 15;
               this._yuanchengCon.direct = param1.direct;
               if(!param1.cooling)
               {
                  this._yuanchengCon.startBar();
               }
               else
               {
                  this._yuanchengCon.setEnabled(false);
               }
               break;
            case Type.QIBING:
            default:
               dispatchEvent(new ConEvent(ConEvent.CREATE_MIAOZHUNJING,true));
         }
      }
      
      private function onSoldierFillCompleteHandler(param1:SoldierEvent) : void
      {
         param1.stopPropagation();
         var _loc2_:AbstractSoldier = param1.target as AbstractSoldier;
         if(this._yuanchengCon.visible && !this._yuanchengCon.getEnabled() && this._currentSoldier == _loc2_)
         {
            this._yuanchengCon.setEnabled(true);
            this._yuanchengCon.startBar();
         }
      }
      
      private function onSoldierFireCompleteHandler(param1:SoldierEvent) : void
      {
         param1.stopPropagation();
         var _loc2_:AbstractSoldier = param1.target as AbstractSoldier;
         if(param1.data && param1.data.type == "baoji" && _loc2_.armyInfo.skill)
         {
            this.showJineng(_loc2_,param1.data.target as AbstractSoldier,Data.getInstance().getAttributes("skill",_loc2_.armyInfo.skill,"mc"),_loc2_.armyInfo.skill);
            return;
         }
         switch(_loc2_.type)
         {
            case Type.TOUSHICHE:
               if(_loc2_.isPlayer)
               {
                  var _loc6_:StoneWeapon = new StoneWeapon(_loc2_,param1.data.angle,param1.data.power,this._ammo);
               }
               else
               {
                  _loc6_ = new StoneWeapon(_loc2_,param1.data.angle,param1.data.power,_loc2_.feature > 0 ? "proto_2_" + (_loc2_.feature + 4) : "proto_2_3");
               }
               var _loc4_:Point = _loc2_.getHurPoint(this);
               _loc6_.x = _loc4_.x;
               _loc6_.y = _loc4_.y;
               addChild(_loc6_);
               _loc6_.addEventListener(WeaponEvent.WEAPON_END,this.onStoneWeaponEndHandler);
               _loc6_.run();
               if(_loc2_.isPlayer && this._ammo != "")
               {
                  dispatchEvent(new FightEvent(FightEvent.USE_AMMO,true,{"id":RoleModel.getInstance().findBagItemID(this._ammo)}));
                  RoleModel.getInstance().delBagItem(this._ammo);
                  if(!RoleModel.getInstance().findBagItem(this._ammo))
                  {
                     Tools.setDisabled(this._currentGrid,true);
                     if(this._currentGrid && this._currentGrid.code == this._ammo)
                     {
                        this._currentGrid.sanjiao.visible = false;
                        this._currentGrid = null;
                     }
                  }
                  else
                  {
                     Tools.setDisabled(this._currentGrid,false);
                  }
                  this._ammo = "";
               }
               break;
            case Type.QIBING:
               var _loc3_:AbstractSoldier = this.findSoldier(_loc2_.direct == 1 ? -1 : 1);
               if(_loc3_)
               {
                  if(Tools.getJilv(_loc3_.shanbi))
                  {
                     _loc3_.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
                  }
                  else
                  {
                     _loc3_.hurt(Logic.getHurtVale(_loc2_,_loc3_),_loc2_);
                  }
               }
               break;
            case Type.JIANTABING:
               var jw:JiantaWeapon = new JiantaWeapon(_loc2_,param1.data.target as AbstractSoldier);
               var jp:Point = _loc2_.getHurPoint(this);
               jw.x = jp.x;
               jw.y = jp.y;
               jw.addEventListener(WeaponEvent.WEAPON_END,this.onJiantaWeaponEndHandler);
               addChildAt(jw,getChildIndex(_loc2_));
               jw.run();
               break;
            case Type.QIANGGONGBING:
               var qw:QianggongWeapon = new QianggongWeapon(_loc2_,param1.data.target as AbstractSoldier);
               var qp:Point = _loc2_.getHurPoint(this);
               qw.x = qp.x;
               qw.y = qp.y;
               qw.addEventListener(WeaponEvent.WEAPON_END,this.onQianggongWeaponEndHandler);
               addChildAt(qw,getChildIndex(_loc2_));
               qw.run();
               break;
            case Type.BOSS:
               if(param1.data && int(param1.data.attackType) == 2)
               {
                  this.shake();
                  var bi:int = 0;
                  while(bi < this._leftSoldiers.length)
                  {
                     var bs:AbstractSoldier = this._leftSoldiers[bi] as AbstractSoldier;
                     if(bs != null)
                     {
                        if(Tools.getJilv(bs.shanbi))
                        {
                           bs.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
                        }
                        else
                        {
                           bs.hurt(this.getBossHurt(bs,BOSS_AOE_RATE),_loc2_);
                        }
                     }
                     bi++;
                  }
               }
               var bt:AbstractSoldier = this.findSoldier(_loc2_.direct == 1 ? -1 : 1);
               if(bt != null)
               {
                  if(Tools.getJilv(bt.shanbi))
                  {
                     bt.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
                  }
                  else
                  {
                     bt.hurt(this.getBossHurt(bt,BOSS_HIT_RATE),_loc2_);
                  }
               }
               break;
            case Type.JUNZHU:
               if(param1.data.type == "baoji")
               {
                  this.showJineng(_loc2_,param1.data.target as AbstractSoldier,"jineng_" + _loc2_.code,null);
                  break;
               }
               var _loc5_:Weapon = new Weapon(_loc2_,param1.data.target as AbstractSoldier);
               _loc4_ = _loc2_.getHurPoint(this);
               _loc5_.x = _loc4_.x;
               _loc5_.y = _loc4_.y;
               _loc5_.addEventListener(WeaponEvent.WEAPON_END,this.onWeaponEndHandler);
               addChildAt(_loc5_,getChildIndex(_loc2_));
               _loc5_.run();
               break;
            default:
               _loc5_ = new Weapon(_loc2_,param1.data.target as AbstractSoldier);
               _loc4_ = _loc2_.getHurPoint(this);
               _loc5_.x = _loc4_.x;
               _loc5_.y = _loc4_.y;
               _loc5_.addEventListener(WeaponEvent.WEAPON_END,this.onWeaponEndHandler);
               addChildAt(_loc5_,getChildIndex(_loc2_));
               _loc5_.run();
         }
      }
      
      private function onStoneWeaponEndHandler(param1:WeaponEvent) : void
      {
         param1.currentTarget.removeEventListener(WeaponEvent.WEAPON_END,this.onStoneWeaponEndHandler);
         var _loc2_:AbstractSoldier = param1.data.hurt;
         this.shake();
         if(_loc2_.direct == 1)
         {
            this.hurtByRec(_loc2_,new Point(param1.currentTarget.x,param1.currentTarget.y),this._rightSoldiers,param1.data.radiu,param1.data.ammo);
         }
         else
         {
            this.hurtByRec(_loc2_,new Point(param1.currentTarget.x,param1.currentTarget.y),this._leftSoldiers,param1.data.radiu,param1.data.ammo);
         }
      }
      
      private function onJiantaWeaponEndHandler(param1:WeaponEvent) : void
      {
         param1.currentTarget.removeEventListener(WeaponEvent.WEAPON_END,this.onJiantaWeaponEndHandler);
         removeChild(param1.currentTarget as JiantaWeapon);
         var _loc2_:AbstractSoldier = param1.data.behurt;
         var _loc3_:AbstractSoldier = param1.data.hurt;
         if(_loc2_ && _loc3_)
         {
            if(Tools.getJilv(_loc2_.shanbi))
            {
               _loc2_.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
            }
            else
            {
               _loc2_.hurt(this.getSpecialHurt(_loc3_,_loc2_,0.05),_loc3_);
            }
         }
      }

      private function onQianggongWeaponEndHandler(param1:WeaponEvent) : void
      {
         param1.currentTarget.removeEventListener(WeaponEvent.WEAPON_END,this.onQianggongWeaponEndHandler);
         removeChild(param1.currentTarget as QianggongWeapon);
         var _loc2_:AbstractSoldier = param1.data.behurt;
         var _loc3_:AbstractSoldier = param1.data.hurt;
         if(_loc2_ && _loc3_)
         {
            if(Tools.getJilv(_loc2_.shanbi))
            {
               _loc2_.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
            }
            else
            {
               _loc2_.hurt(this.getSpecialHurt(_loc3_,_loc2_,0.03),_loc3_);
            }
         }
      }

      /** Boss 伤害：按目标最大生命的固定比例，避免固定攻击力对低血量武将过疼/对高防玩家无关 */
      private function getBossHurt(param1:AbstractSoldier, param2:Number) : int
      {
         var _loc3_:int = int(param1.maxHP * param2);
         return _loc3_ < 1 ? 1 : _loc3_;
      }

      /** 特殊兵种伤害：至少造成目标最大生命的一定比例，避免固定等级敌人对高级玩家完全无效 */
      private function getSpecialHurt(param1:AbstractSoldier, param2:AbstractSoldier, param3:Number) : int
      {
         var _loc4_:int = Logic.getHurtVale(param1,param2);
         var _loc5_:int = int(param2.maxHP * param3);
         if(_loc5_ < 1)
         {
            _loc5_ = 1;
         }
         return _loc4_ < _loc5_ ? _loc5_ : _loc4_;
      }

      private function onWeaponEndHandler(param1:WeaponEvent) : void
      {
         param1.currentTarget.removeEventListener(WeaponEvent.WEAPON_END,this.onWeaponEndHandler);
         removeChild(param1.currentTarget as Weapon);
         var _loc2_:AbstractSoldier = param1.data.behurt;
         var _loc3_:AbstractSoldier = param1.data.hurt;
         if(_loc2_ && _loc3_)
         {
            if(Tools.getJilv(_loc2_.shanbi))
            {
               _loc2_.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
            }
            else
            {
               _loc2_.hurt(Logic.getHurtVale(_loc3_,_loc2_),_loc3_);
            }
         }
      }
      
      private function showJineng(param1:AbstractSoldier, param2:AbstractSoldier, param3:String, param4:String) : void
      {
         var _loc5_:Class;
         var _loc6_:MovieClip;
         if(!param2)
         {
            return;
         }
         if(param3)
         {
            try
            {
               _loc5_ = ApplicationDomain.currentDomain.getDefinition(param3) as Class;
            }
            catch(e:Error)
            {
            }
         }
         if(_loc5_)
         {
            _loc6_ = new _loc5_() as MovieClip;
         }
         else if(param4)
         {
            _loc6_ = this.createDynJineng(param4);
         }
         if(!_loc6_)
         {
            return;
         }
         _loc6_.mouseEnabled = false;
         _loc6_.mouseChildren = false;
         _loc6_.addEventListener(Event.ENTER_FRAME,this.jinengEnterFrameHandler);
         _loc6_.scaleX = 0.9 * param1.direct;
         _loc6_.scaleY = 0.9;
         _loc6_.x = param2.x;
         _loc6_.y = param1.y;
         _loc6_.direct = param1.direct;
         _loc6_.skill = param4;
         _loc6_.owner = param1;
         addChild(_loc6_);
      }
      
      private function createDynJineng(param1:String) : MovieClip
      {
         var _loc2_:* = Data.getInstance().getAttributes("skill",param1,"dyn");
         if(!_loc2_ || _loc2_ == "")
         {
            return null;
         }
         var _loc3_:MovieClip = new MovieClip();
         _loc3_.dynFrame = 0;
         _loc3_.dynHurt = 4;
         _loc3_.dynTotal = 26;
         _loc3_.dynType = int(_loc2_);
         this.drawDynJineng(_loc3_,0);
         return _loc3_;
      }
      
      private function dynJinengFrame(param1:MovieClip) : void
      {
         param1.dynFrame = int(param1.dynFrame) + 1;
         if(param1.dynFrame == param1.dynHurt)
         {
            this.applyJineng(param1);
         }
         this.drawDynJineng(param1,param1.dynFrame);
         if(param1.dynFrame >= param1.dynTotal)
         {
            param1.removeEventListener(Event.ENTER_FRAME,this.jinengEnterFrameHandler);
            removeChild(param1);
         }
      }
      
      private function drawDynJineng(param1:MovieClip, param2:int) : void
      {
         var _loc3_:Number = param2 / Number(param1.dynTotal);
         var _loc4_:Graphics = param1.graphics;
         var _loc5_:int = int(param1.dynType);
         _loc4_.clear();
         if(_loc5_ == 3)
         {
            var _a1_:Number = Math.max(0,1 - _loc3_ * 3.2);
            if(_a1_ > 0)
            {
               _loc4_.beginFill(16768502,_a1_);
               _loc4_.drawCircle(0,0,10 + Math.min(_loc3_ * 3,1) * 26);
               _loc4_.endFill();
            }
            var _a2_:Number = Math.max(0,1 - _loc3_ * 1.3);
            if(_a2_ > 0)
            {
               _loc4_.beginFill(16747546,_a2_);
               var _i_:int = 0;
               while(_i_ < 5)
               {
                  var _x_:Number = (_i_ - 2) * 20 * (0.4 + _loc3_);
                  var _y_:Number = 16 - _loc3_ * 78 - _i_ * 3;
                  var _h_:Number = 13 * (1 - _loc3_ * 0.35);
                  _loc4_.moveTo(_x_,_y_ - _h_ * 2);
                  _loc4_.lineTo(_x_ + _h_ * 0.6,_y_ + _h_);
                  _loc4_.lineTo(_x_ - _h_ * 0.6,_y_ + _h_);
                  _loc4_.lineTo(_x_,_y_ - _h_ * 2);
                  _i_++;
               }
               _loc4_.endFill();
            }
            _loc4_.lineStyle(5,16737280,Math.max(0,1 - Math.max(0,_loc3_ - 0.16) * 1.6));
            _loc4_.drawCircle(0,0,18 + _loc3_ * 74);
         }
         else if(_loc5_ == 4)
         {
            var _b1_:Number = Math.max(0,1 - _loc3_ * 1.15);
            if(_b1_ > 0)
            {
               _loc4_.beginFill(14219263,_b1_);
               var _j_:int = 0;
               while(_j_ < 6)
               {
                  var _ang_:Number = _j_ * 60 * Math.PI / 180;
                  var _cos_:Number = Math.cos(_ang_);
                  var _sin_:Number = Math.sin(_ang_);
                  var _r_:Number = 10 + _loc3_ * 86;
                  var _w_:Number = 30 * (1 - _loc3_ * 0.25);
                  var _px_:Number = _r_ * _cos_;
                  var _py_:Number = _r_ * _sin_;
                  _loc4_.moveTo(_px_ + _w_ * _cos_,_py_ + _w_ * _sin_);
                  _loc4_.lineTo(_px_ + 8 * _sin_,_py_ - 8 * _cos_);
                  _loc4_.lineTo(_px_ - _w_ * _cos_,_py_ - _w_ * _sin_);
                  _loc4_.lineTo(_px_ - 8 * _sin_,_py_ + 8 * _cos_);
                  _loc4_.lineTo(_px_ + _w_ * _cos_,_py_ + _w_ * _sin_);
                  _j_++;
               }
               _loc4_.endFill();
            }
            _loc4_.lineStyle(4,9234175,Math.max(0,1 - Math.max(0,_loc3_ - 0.12) * 1.5));
            _loc4_.drawCircle(0,0,25 + _loc3_ * 80);
            _loc4_.lineStyle(2,16777215,Math.max(0,1 - _loc3_ * 2.4));
            _loc4_.drawCircle(0,0,(25 + _loc3_ * 80) * 0.45);
         }
         else if(_loc5_ == 5)
         {
            var _c1_:Number = Math.max(0,1 - _loc3_ * 1.1);
            if(_c1_ > 0)
            {
               _loc4_.beginFill(10354301,_c1_);
               var _k_:int = 0;
               while(_k_ < 6)
               {
                  var _cx_:Number = (_k_ - 2.5) * 15;
                  var _cy_:Number = 30 - _loc3_ * 96 - (_k_ - _k_ / 3 * 3) * 9;
                  _loc4_.drawCircle(_cx_,_cy_,4.5);
                  _k_++;
               }
               _loc4_.endFill();
            }
            var _c2_:Number = Math.max(0,1 - _loc3_ * 1.6) * Math.min(1,_loc3_ * 4);
            if(_c2_ > 0)
            {
               var _s_:Number = 8 + 4 * Math.min(1,_loc3_ * 3);
               _loc4_.beginFill(15269864,_c2_);
               _loc4_.moveTo(-_s_,-26);
               _loc4_.lineTo(_s_,-26);
               _loc4_.lineTo(_s_,-_s_);
               _loc4_.lineTo(26,-_s_);
               _loc4_.lineTo(26,_s_);
               _loc4_.lineTo(_s_,_s_);
               _loc4_.lineTo(_s_,26);
               _loc4_.lineTo(-_s_,26);
               _loc4_.lineTo(-_s_,_s_);
               _loc4_.lineTo(-26,_s_);
               _loc4_.lineTo(-26,-_s_);
               _loc4_.lineTo(-_s_,-_s_);
               _loc4_.lineTo(-_s_,-26);
               _loc4_.endFill();
            }
            _loc4_.lineStyle(4,8188796,Math.max(0,1 - _loc3_ * 1.3));
            _loc4_.drawCircle(0,0,16 + _loc3_ * 42);
         }
      }
      
      private function jinengEnterFrameHandler(param1:Event) : void
      {
         var _loc2_:MovieClip = param1.currentTarget as MovieClip;
         if(_loc2_.dynTotal > 0)
         {
            this.dynJinengFrame(_loc2_);
            return;
         }
         if(_loc2_.currentFrameLabel == "_jinengOver")
         {
            _loc2_.removeEventListener(Event.ENTER_FRAME,this.jinengEnterFrameHandler);
            removeChild(_loc2_);
         }
         else if(_loc2_.currentFrameLabel == "_hurt")
         {
            this.applyJineng(_loc2_);
         }
      }
      
      private function applyJineng(param1:MovieClip) : void
      {
         var _loc2_:String = param1.skill;
         var _loc3_:AbstractSoldier = param1.owner as AbstractSoldier;
         var _loc4_:Array = param1.direct == 1 ? this._rightSoldiers : this._leftSoldiers;
         if(!_loc2_)
         {
            this.hurtByJineng(new Point(param1.x,param1.y),_loc4_,75);
            return;
         }
         var _loc5_:int = Data.getInstance().getAttributes("skill",_loc2_,"effect");
         var _loc6_:Number = Data.getInstance().getAttributes("skill",_loc2_,"value");
         if(_loc3_)
         {
            _loc6_ = Config.skillValueAtLevel(_loc6_,_loc3_.armyInfo.skillLevel);
         }
         if(_loc5_ == 3)
         {
            if(_loc3_)
            {
               _loc3_.heal(Config.skillHeal(_loc3_.maxHP,_loc6_));
            }
            return;
         }
         var _loc7_:Number = Data.getInstance().getAttributes("skill",_loc2_,"radius");
         this.hurtByJinengSkill(new Point(param1.x,param1.y),_loc4_,_loc7_,_loc6_,_loc5_,_loc3_);
      }
      
      private function hurtByRec(param1:AbstractSoldier, param2:Point, param3:Array, param4:int, param5:String) : void
      {
         var _loc6_:Rectangle = new Rectangle(param2.x - param4,0,param4 * 2,stage.stageHeight);
         var _loc7_:int = 0;
         while(_loc7_ < param3.length)
         {
            var _loc8_:AbstractSoldier = param3[_loc7_] as AbstractSoldier;
            if(_loc6_.intersects(_loc8_.getRect(this)))
            {
               if(Tools.getJilv(_loc8_.shanbi))
               {
                  _loc8_.dispatchEvent(new SoldierEvent(SoldierEvent.SHANBI,true));
               }
               else
               {
                  _loc8_.hurt(Logic.getHurtVale(param1,_loc8_,param5),param1);
               }
               return;
            }
            _loc7_++;
         }
      }
      
      private function hurtByJineng(param1:Point, param2:Array, param3:Number) : void
      {
         var _loc4_:Rectangle = new Rectangle(param1.x - param3,0,param3 * 2,stage.stageHeight);
         var _loc5_:int = 0;
         while(_loc5_ < param2.length)
         {
            var _loc6_:AbstractSoldier = param2[_loc5_] as AbstractSoldier;
            if(_loc4_.intersects(_loc6_.getRect(this)))
            {
               _loc6_.hurt(_loc6_.maxHP / 10);
            }
            _loc5_++;
         }
      }
      
      private function hurtByJinengSkill(param1:Point, param2:Array, param3:Number, param4:Number, param5:int, param6:AbstractSoldier) : void
      {
         var _loc7_:Rectangle = new Rectangle(param1.x - param3,0,param3 * 2,stage.stageHeight);
         var _loc8_:int = 0;
         while(_loc8_ < param2.length)
         {
            var _loc9_:AbstractSoldier = param2[_loc8_] as AbstractSoldier;
            if(_loc7_.intersects(_loc9_.getRect(this)))
            {
               _loc9_.hurt(Config.skillDamage(_loc9_.maxHP,(param6 != null ? param6.attack : 0),param4,param5),param6);
            }
            _loc8_++;
         }
      }
      
      private function onSoldierBehurtHandler(param1:SoldierEvent) : void
      {
         this._tipsLayer.addTips(param1.data as int,new Point(param1.target.x,param1.target.y - 50));
      }
      
      private function onSoldierShanbiHandler(param1:SoldierEvent) : void
      {
         this._tipsLayer.addShanbi(new Point(param1.target.x,param1.target.y - 50));
      }
      
      private function onSoldierHuifuHandler(param1:SoldierEvent) : void
      {
         this._tipsLayer.addTips2(param1.data as int,new Point(param1.target.x,param1.target.y - 50));
      }
      
      private function onSoldierDeadHandler(param1:SoldierEvent) : void
      {
         var _loc2_:AbstractSoldier = param1.target as AbstractSoldier;
         if(this._currentSoldier == _loc2_)
         {
            this.resetController();
            this._currentSoldier = null;
         }
         this._fightUI.checkDead(_loc2_.armyInfo.id,_loc2_.armyInfo.code);
      }
      
      private function onSoldierDeadCompleteHandler(param1:SoldierEvent) : void
      {
         this.removeSoldier(param1.target as AbstractSoldier);
         if(this._isOver)
         {
            return;
         }
         if(this._leftSoldiers.length == 0)
         {
            this.clear();
            this._isOver = true;
            var _loc2_:String = this._direct == 1 ? "lost" : "win";
            var _loc3_:Number = this.getLeftLevelAverage();
            var _loc4_:Number = this.getRightLevelAverage();
            dispatchEvent(new FightEvent(FightEvent.FIGHT_COMPLETE,true,{
               "flag":_loc2_,
               "m":_loc3_,
               "n":_loc4_,
               "part":this._part,
               "level":this._level
            }));
         }
         else if(this._rightSoldiers.length == 0)
         {
            this.clear();
            this._isOver = true;
            _loc2_ = this._direct == 1 ? "win" : "lost";
            _loc3_ = this.getLeftLevelAverage();
            _loc4_ = this.getRightLevelAverage();
            dispatchEvent(new FightEvent(FightEvent.FIGHT_COMPLETE,true,{
               "flag":_loc2_,
               "m":_loc3_,
               "n":_loc4_,
               "part":this._part,
               "level":this._level
            }));
         }
      }
      
      private function getLeftLevelAverage() : Number
      {
         var _loc1_:int = 0;
         var _loc2_:int = 0;
         while(_loc2_ < this._leftArmy.length)
         {
            _loc1_ += this._leftArmy[_loc2_].level;
            _loc2_++;
         }
         return _loc1_;
      }
      
      private function getRightLevelAverage() : Number
      {
         var _loc1_:int = 0;
         var _loc2_:int = 0;
         while(_loc2_ < this._rightArmy.length)
         {
            _loc1_ += this._rightArmy[_loc2_].level;
            _loc2_++;
         }
         return _loc1_;
      }
      
      private function removeSoldier(param1:AbstractSoldier) : void
      {
         if(this._ai && !param1.isPlayer)
         {
            this._ai.killSoldier(param1);
         }
         if(param1.direct == 1)
         {
            var _loc2_:int = this._leftSoldiers.indexOf(param1);
            this._leftSoldiers.splice(_loc2_,1);
         }
         else
         {
            _loc2_ = this._rightSoldiers.indexOf(param1);
            this._rightSoldiers.splice(_loc2_,1);
         }
         removeChild(param1);
      }
      
      public function clear() : void
      {
         if(this._timer)
         {
            this._timer.reset();
            this._timer.removeEventListener(TimerEvent.TIMER,this.speedCheckHandler);
            this._timer = null;
         }
         this.removeAllEvent();
         if(this.stage != null)
         {
            this.stage.removeEventListener(SoldierEvent.RETREAT,this.onRetreatHandler);
            this.stage.removeEventListener(KeyboardEvent.KEY_DOWN,this.onKeydownHandler);
            this.stage.removeEventListener(MouseEvent.CLICK,this.onStageClick,true);
         }
         Mouse.show();
         Mouse.prototype.isHide = false;
         Mouse.prototype.canFire = false;
         if(this._ai)
         {
            this._ai.stopAI();
         }
         this._yuanchengCon.stopBar();
         this._yuanchengCon.visible = false;
         this._miaozhunjing.visible = false;
      }
      
      private function speedCheckHandler(param1:TimerEvent) : void
      {
         var _loc2_:Number = new Date().getTime() - this._date;
         if(_loc2_ < Config.ERROR)
         {
            ++this._biansu;
            if(this._biansu >= Config.ERROR_COUNT)
            {
               this._timer.reset();
               this._timer.removeEventListener(TimerEvent.TIMER,this.speedCheckHandler);
               this._timer = null;
               this.clear();
               dispatchEvent(new UIEvent(UIEvent.SPEED_CHECKOUT,true,{"flag":"bigmap"}));
            }
         }
         else if(_loc2_ == Config.NORMAL)
         {
            this._biansu = 0;
            this._date = new Date().getTime();
         }
         else
         {
            this._date = new Date().getTime();
         }
      }
      
      private function removeAllEvent() : void
      {
         removeEventListener(SoldierEvent.SELECTED,this.onSoldierSelectedHandler);
         removeEventListener(SoldierEvent.ENEMY_SELECTED,this.onEnemySelectedHandler);
         removeEventListener(SoldierEvent.SMART_ATTACK,this.smartAttackHandler);
         removeEventListener(MouseEvent.CLICK,this.onMouseClickHandler);
         removeEventListener(ConEvent.CREATE_MIAOZHUNJING,this.createMiaozhunjingHandler);
         removeEventListener(ConEvent.FIRE,this.conFireHandler);
         removeEventListener(SoldierEvent.FILL_COMPLETE,this.onSoldierFillCompleteHandler);
         removeEventListener(SoldierEvent.FIRE_COMPLETE,this.onSoldierFireCompleteHandler);
         removeEventListener(SoldierEvent.BEHURT,this.onSoldierBehurtHandler);
         removeEventListener(SoldierEvent.SHANBI,this.onSoldierShanbiHandler);
         removeEventListener(SoldierEvent.HUIFU,this.onSoldierHuifuHandler);
         removeEventListener(SoldierEvent.DEAD,this.onSoldierDeadHandler);
         removeEventListener(SoldierEvent.DEAD_COMPLETE,this.onSoldierDeadCompleteHandler);
         this._miaozhunjing.removeEventListener(Event.ENTER_FRAME,this.onMiaozhunjingEnterFrameHandler);
         removeEventListener(SoldierEvent.ENEMY_LOCKED,this.enemyLockHandler);
         removeEventListener(SoldierEvent.ENEMY_UNLOCKED,this.enemyUnlockHandler);
         removeEventListener(SoldierEvent.ZHAOHUAN,this.onSoldierZhaohuanHandler);
         this._gridContainer.removeEventListener(MouseEvent.CLICK,this.onGridClickHandler);
         this.hideAmmoTipsHandler(null);
      }

      private function onSoldierZhaohuanHandler(param1:SoldierEvent) : void
      {
         var talker:AbstractSoldier = param1.target as AbstractSoldier;
         if(talker != null)
         {
            talker.talk({"text":"小的们，给我上！","delay":2000});
         }
         var count:int = int(param1.data.count);
         if(count <= 0)
         {
            count = 3;
         }
         var lv:int = Math.max(10,(this._level + 1) * 4);
         var arr:Array = null;
         try
         {
            arr = this._ai["qianggongArr"] as Array;
         }
         catch(e:Error)
         {
            arr = null;
         }
         var i:int = 0;
         while(i < count && this._rightSoldiers.length < 8)
         {
            var info:ArmyInfo = Data.getInstance().getArmyInfo("general_12_1",lv,0,0,"乌林弓手",3000,90);
            var soldier:QianggongSoldier = new QianggongSoldier(info,-1,false,this);
            soldier.x = 540 + Math.random() * 160;
            soldier.y = 330 + Math.random() * 70;
            addChild(soldier);
            this._rightSoldiers.push(soldier);
            if(arr != null)
            {
               arr.push(soldier);
            }
            soldier.goLeft(120);
            i++;
         }
      }
      
      private function shake() : void
      {
         var _loc1_:int = Math.random() > 0.5 ? -1 : 1;
         y += (5 + Math.random() * 10) * _loc1_;
         TweenLite.to(this,0.6,{
            "y":0,
            "x":0,
            "rotation":0,
            "ease":Elastic.easeOut
         });
      }
      
      private function onStageClick(param1:MouseEvent) : void
      {
      }
      
      private function onRetreatHandler(param1:SoldierEvent) : void
      {
         var _loc2_:Array = this._direct == 1 ? this._leftSoldiers : this._rightSoldiers;
         var _loc3_:int = 0;
         while(_loc3_ < _loc2_.length)
         {
            var _loc4_:AbstractSoldier = _loc2_[_loc3_] as AbstractSoldier;
            if(_loc4_ && !_loc4_.isDead && _loc4_.type != Type.TOUSHICHE)
            {
               _loc4_.stand();
               if(this._direct == 1)
               {
                  _loc4_.goLeft(100);
               }
               else
               {
                  _loc4_.goRight(100);
               }
            }
            _loc3_++;
         }
      }
      
      private function onKeydownHandler(param1:KeyboardEvent) : void
      {
         switch(param1.keyCode)
         {
            case 49:
               this._fightUI.setSelect(1);
               break;
            case 50:
               this._fightUI.setSelect(2);
               break;
            case 51:
               this._fightUI.setSelect(3);
               break;
            case 52:
               this._fightUI.setSelect(4);
               break;
            case 53:
               this._fightUI.setSelect(5);
         }
      }
      
      private function hideAmmoTipsHandler(param1:MouseEvent) : void
      {
         stage.removeEventListener(MouseEvent.MOUSE_DOWN,this.hideAmmoTipsHandler,true);
         this._ammoTips.visible = false;
      }
      
      public function setAmmoTips(param1:AbstractSoldier) : *
      {
         if(this._ammoTips.visible)
         {
            return;
         }
         this._ammoTips.x = param1.x;
         this._ammoTips.y = param1.y - 70;
         this._ammoTips.visible = true;
         stage.addEventListener(MouseEvent.MOUSE_DOWN,this.hideAmmoTipsHandler,true);
      }
      
      private function selectSoldier(param1:Number, param2:String) : AbstractSoldier
      {
         var _loc3_:int = 0;
         while(_loc3_ < this._leftSoldiers.length)
         {
            if(this._leftSoldiers[_loc3_].armyInfo.id == param1 && this._leftSoldiers[_loc3_].armyInfo.code == param2)
            {
               return this._leftSoldiers[_loc3_];
            }
            _loc3_++;
         }
         return null;
      }
      
      public function findSoldier(param1:int) : AbstractSoldier
      {
         if(param1 == 1)
         {
            if(this._leftSoldiers.length == 0)
            {
               return null;
            }
            if(this._leftSoldiers.length == 1)
            {
               return this._leftSoldiers[0];
            }
            var _loc2_:AbstractSoldier = this._leftSoldiers[0];
            var _loc3_:int = 1;
            while(_loc3_ < this._leftSoldiers.length)
            {
               if(this._leftSoldiers[_loc3_].x > _loc2_.x)
               {
                  _loc2_ = this._leftSoldiers[_loc3_];
               }
               _loc3_++;
            }
            return _loc2_;
         }
         if(this._rightSoldiers.length == 0)
         {
            return null;
         }
         if(this._rightSoldiers.length == 1)
         {
            return this._rightSoldiers[0];
         }
         _loc2_ = this._rightSoldiers[0];
         var _loc4_:int = 1;
         while(_loc4_ < this._rightSoldiers.length)
         {
            if(this._rightSoldiers[_loc4_].x < _loc2_.x)
            {
               _loc2_ = this._rightSoldiers[_loc4_];
            }
            _loc4_++;
         }
         return _loc2_;
      }
      
      public function getDistance(param1:AbstractSoldier, param2:AbstractSoldier) : Number
      {
         if(!param1 || !param2)
         {
            return 0;
         }
         var _loc3_:Number = param1.moveDistance * MERIC;
         var _loc4_:Number = this.getAllDistance(param1,param2);
         return _loc4_ >= _loc3_ ? _loc3_ : _loc4_;
      }
      
      public function getAllDistance(param1:AbstractSoldier, param2:AbstractSoldier) : Number
      {
         if(!param1 || !param2)
         {
            return 0;
         }
         var _loc3_:Rectangle = param1.getRectangle(this);
         var _loc4_:Rectangle = param2.getRectangle(this);
         var _loc5_:Number = param1.direct == 1 ? _loc4_.left - _loc3_.right : _loc3_.left - _loc4_.right;
         return _loc5_ < 0 ? 0 : _loc5_;
      }
      
      public function checkLeft(param1:AbstractSoldier) : Boolean
      {
         if(param1.direct == 1)
         {
            return true;
         }
         var _loc2_:AbstractSoldier = this.findSoldier(1);
         if(!_loc2_)
         {
            return true;
         }
         return this.getAllDistance(param1,_loc2_) > 0;
      }
      
      public function checkRight(param1:AbstractSoldier) : Boolean
      {
         if(param1.direct == -1)
         {
            return true;
         }
         var _loc2_:AbstractSoldier = this.findSoldier(-1);
         if(!_loc2_)
         {
            return true;
         }
         return this.getAllDistance(param1,_loc2_) > 0;
      }
      
      public function get leftSoldiers() : Array
      {
         return this._leftSoldiers;
      }
      
      public function get rightSoldiers() : Array
      {
         return this._rightSoldiers;
      }
      
      public function get ammo() : String
      {
         return this._ammo;
      }
      
      public function getAutoMode() : Boolean
      {
         return false;
      }
   }
}

