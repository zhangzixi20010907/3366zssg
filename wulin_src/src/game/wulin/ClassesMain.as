package game.wulin
{
   import flash.display.DisplayObject;
   import flash.display.DisplayObjectContainer;
   import flash.display.Shape;
   import flash.display.Sprite;
   import flash.display.Stage;
   import flash.events.MouseEvent;
   import flash.events.TimerEvent;
   import flash.filesystem.File;
   import flash.filesystem.FileMode;
   import flash.filesystem.FileStream;
   import flash.filters.GlowFilter;
   import flash.text.TextField;
   import flash.text.TextFormat;
   import flash.text.TextFormatAlign;
   import flash.utils.Timer;
   import flash.utils.getDefinitionByName;
   import flash.utils.getQualifiedClassName;
   import game.UI;
   import game.fuben.WulinBossGate;
   import game.ui.bigmap_wulin;

   /**
    * wulin_classes.swf 的文档类。
    * 加载后轮询主 SWF，找到 game::UI / game.ui::Map，
    * 把 Map 皮肤里的 _wulinArt（原始 61172 建筑图）绑定为乌林入口。
    * 这样入口美术完全不依赖 SymbolClass 跨 SWF 绑定。
    */
   public class ClassesMain extends Sprite
   {
      private static var _keep1:Class = bigmap_wulin;
      private static var _keep4:Class = WulinBossGate;

      private var _timer:Timer;
      private var _ui:UI;
      private var _entryBtn:DisplayObject;
      private var _panel:bigmap_wulin;
      private var _labelAdded:Boolean = false;
      private var _lastNote:String = "";

      public function ClassesMain()
      {
         super();
         this._timer = new Timer(500);
         this._timer.addEventListener(TimerEvent.TIMER,this.onTick);
         this._timer.start();
         this.onTick(null);
      }

      private function getMainStage() : Stage
      {
         if(this.stage != null)
         {
            return this.stage;
         }
         try
         {
            var ldr:Object = this.loaderInfo == null ? null : this.loaderInfo.loader;
            if(ldr != null && ldr.stage != null)
            {
               return ldr.stage as Stage;
            }
         }
         catch(e1:Error)
         {
         }
         try
         {
            var naClass:Class = getDefinitionByName("flash.desktop.NativeApplication") as Class;
            var app:Object = naClass["nativeApplication"];
            var win:Object = app.openedWindows[0];
            if(win != null && win.stage != null)
            {
               return win.stage as Stage;
            }
         }
         catch(e2:Error)
         {
         }
         return null;
      }

      private function onTick(e:TimerEvent) : void
      {
         var st:Stage = this.getMainStage();
         if(st == null || st.numChildren == 0)
         {
            this.logNote("no stage");
            return;
         }
         if(this._ui == null)
         {
            this._ui = this.findQName(st,"game::UI") as UI;
         }
         if(this._ui == null)
         {
            this.logNote("stage ok, no UI");
            return;
         }
         if(this._entryBtn != null && this._entryBtn.stage == null)
         {
            this._entryBtn = null;
            this._labelAdded = false;
         }
         if(this._entryBtn == null)
         {
            try
            {
               this.hookMapEntry();
            }
            catch(errHook:Error)
            {
               this.logError("hook",errHook);
            }
            if(this._entryBtn == null)
            {
               this.logNote("UI ok, no _wulinArt");
            }
            else
            {
               this.logNote("hooked _wulinArt");
            }
         }
         if(this._entryBtn != null && !this._labelAdded)
         {
            try
            {
               this.addEntryLabel(this._entryBtn as DisplayObjectContainer);
            }
            catch(errLabel:Error)
            {
               this.logError("label",errLabel);
            }
            if(this._labelAdded)
            {
               this.logNote("label ok");
            }
         }
         if(this._panel != null && this._panel.parent == null)
         {
            this._panel = null;
         }
      }

      private function hookMapEntry() : void
      {
         var map:DisplayObject = this.findQName(this._ui,"game.ui::Map");
         if(map == null)
         {
            return;
         }
         var skin:Object = null;
         try
         {
            skin = map["getSkin"]();
         }
         catch(e1:Error)
         {
            return;
         }
         if(skin == null || !(skin is DisplayObjectContainer))
         {
            return;
         }
         var btn:DisplayObject = (skin as DisplayObjectContainer).getChildByName("_wulinArt");
         if(btn == null)
         {
            return;
         }
         this._entryBtn = btn;
         if(!btn.hasEventListener(MouseEvent.CLICK))
         {
            btn.addEventListener(MouseEvent.CLICK,this.onEntryClick);
         }
         try
         {
            (btn as Object)["buttonMode"] = true;
         }
         catch(e2:Error)
         {
         }
      }

      private function addEntryLabel(btn:DisplayObjectContainer) : void
      {
         if(this._labelAdded || btn == null)
         {
            return;
         }
         if(btn.getChildByName("_wulinLabel") != null)
         {
            this._labelAdded = true;
            return;
         }
         var bg:Shape = new Shape();
         bg.name = "_wulinLabelBg";
         bg.graphics.beginFill(0x000000,0.6);
         bg.graphics.drawRect(-60,2,120,20);
         bg.graphics.endFill();
         btn.addChild(bg);
         var tf:TextField = new TextField();
         tf.name = "_wulinLabel";
         tf.selectable = false;
         tf.mouseEnabled = false;
         tf.multiline = false;
         tf.width = 120;
         tf.height = 20;
         tf.x = -60;
         tf.y = 2;
         var fmt:TextFormat = new TextFormat();
         fmt.font = "SimSun";
         fmt.size = 14;
         fmt.bold = true;
         fmt.color = 0xffee88;
         fmt.align = TextFormatAlign.CENTER;
         tf.defaultTextFormat = fmt;
         tf.text = "乌林遗迹";
         tf.filters = [new GlowFilter(0x000000,1,3,3,3,1)];
         btn.addChild(tf);
         this._labelAdded = true;
      }

      private function onEntryClick(e:MouseEvent) : void
      {
         e.stopImmediatePropagation();
         if(this._ui == null)
         {
            return;
         }
         if(this._panel != null && this._panel.parent != null)
         {
            this._panel.refresh();
            return;
         }
         if(this._ui.getChildByName("wulinBigMap") != null)
         {
            return;
         }
         try
         {
            var panel:bigmap_wulin = new bigmap_wulin(this._ui);
            panel.name = "wulinBigMap";
            panel.x = this._ui.stage.stageWidth / 2;
            panel.y = this._ui.stage.stageHeight / 2;
            this._ui.addChild(panel);
            panel.drawMask();
            this._panel = panel;
         }
         catch(err:Error)
         {
            this.logError("open",err);
            this._ui.showMsg({"type":0,"text":"乌林遗迹打开失败：" + err.message});
         }
      }

      private function findQName(root:DisplayObjectContainer,qn:String) : DisplayObject
      {
         if(root == null)
         {
            return null;
         }
         var n:int = root.numChildren;
         var i:int = 0;
         while(i < n)
         {
            var c:DisplayObject = null;
            try
            {
               c = root.getChildAt(i);
            }
            catch(e:Error)
            {
               i++;
               continue;
            }
            if(getQualifiedClassName(c) == qn)
            {
               return c;
            }
            if(c is DisplayObjectContainer)
            {
               var r:DisplayObject = this.findQName(c as DisplayObjectContainer,qn);
               if(r != null)
               {
                  return r;
               }
            }
            i++;
         }
         return null;
      }

      private function logNote(note:String) : void
      {
         if(note == this._lastNote)
         {
            return;
         }
         this._lastNote = note;
         try
         {
            var f:File = File.applicationDirectory.resolvePath("wulin_hook.txt");
            var fs:FileStream = new FileStream();
            fs.open(f,FileMode.WRITE);
            fs.writeUTFBytes(note);
            fs.close();
         }
         catch(e1:Error)
         {
            try
            {
               var f2:File = File.desktopDirectory.resolvePath("wulin_hook.txt");
               var fs2:FileStream = new FileStream();
               fs2.open(f2,FileMode.WRITE);
               fs2.writeUTFBytes(note);
               fs2.close();
            }
            catch(e2:Error)
            {
            }
         }
      }

      private function logError(tag:String,err:Error) : void
      {
         var text:String = tag + " " + err.name + " " + err.message + "\n" + err.getStackTrace();
         try
         {
            var f:File = File.applicationDirectory.resolvePath("wulin_error.txt");
            var fs:FileStream = new FileStream();
            fs.open(f,FileMode.WRITE);
            fs.writeUTFBytes(text);
            fs.close();
         }
         catch(e1:Error)
         {
            try
            {
               var f2:File = File.desktopDirectory.resolvePath("wulin_error.txt");
               var fs2:FileStream = new FileStream();
               fs2.open(f2,FileMode.WRITE);
               fs2.writeUTFBytes(text);
               fs2.close();
            }
            catch(e2:Error)
            {
            }
         }
      }
   }
}
