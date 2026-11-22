package game.ui
{
   import flash.display.DisplayObject;
   import flash.display.MovieClip;
   import flash.display.Shape;
   import flash.events.MouseEvent;
   import flash.text.TextField;
   import flash.text.TextFormat;
   import flash.text.TextFormatAlign;
   import game.UI;

   /**
    * 主地图上的「乌林遗迹」入口按钮（美术在 ui.swf 的 uiSkin_Map 里）。
    * 点击后直接在 UI 上创建 bigmap_wulin。
    */
   public class WulinEntryButton extends MovieClip
   {
      public function WulinEntryButton()
      {
         super();
         this.buttonMode = true;
         this.mouseChildren = false;
         this.graphics.beginFill(0,0);
         this.graphics.drawRect(-60,-110,120,140);
         this.graphics.endFill();
         addEventListener(MouseEvent.CLICK,this.onClick);
         var bg:Shape = new Shape();
         bg.graphics.beginFill(0x000000,0.55);
         bg.graphics.drawRect(-60,0,120,20);
         bg.graphics.endFill();
         addChild(bg);
         var tf:TextField = new TextField();
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
         addChild(tf);
      }

      private function onClick(e:MouseEvent) : void
      {
         e.stopImmediatePropagation();
         var ui:UI = this.findUI();
         if(ui == null)
         {
            return;
         }
         if(ui.getChildByName("wulinBigMap") != null)
         {
            return;
         }
         try
         {
            var panel:bigmap_wulin = new bigmap_wulin(ui);
            panel.name = "wulinBigMap";
            panel.x = ui.stage.stageWidth / 2;
            panel.y = ui.stage.stageHeight / 2;
            ui.addChild(panel);
            panel.drawMask();
         }
         catch(err:Error)
         {
            ui.showMsg({"type":0,"text":"乌林遗迹打开失败：" + err.message});
         }
      }

      private function findUI() : UI
      {
         var p:DisplayObject = this;
         while(p != null)
         {
            if(p is UI)
            {
               return p as UI;
            }
            p = p.parent;
         }
         return null;
      }

   }
}
