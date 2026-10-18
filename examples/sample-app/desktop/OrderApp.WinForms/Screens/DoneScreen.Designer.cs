namespace OrderApp.WinForms.Screens;

partial class DoneScreen
{
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Component Designer generated code

    private void InitializeComponent()
    {
        this.title = new System.Windows.Forms.Label();
        this.doneMessage = new System.Windows.Forms.Label();
        this.toList = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // title
        //
        this.title.AutoSize = true;
        this.title.Font = new System.Drawing.Font("Yu Gothic UI", 13F, System.Drawing.FontStyle.Bold);
        this.title.Location = new System.Drawing.Point(0, 0);
        this.title.Name = "title";
        this.title.Size = new System.Drawing.Size(46, 25);
        this.title.TabIndex = 0;
        this.title.Text = "完了";
        //
        // doneMessage
        //
        this.doneMessage.AutoSize = true;
        this.doneMessage.Location = new System.Drawing.Point(0, 40);
        this.doneMessage.Name = "done-message";
        this.doneMessage.Size = new System.Drawing.Size(127, 15);
        this.doneMessage.TabIndex = 1;
        this.doneMessage.Text = "注文を受け付けました";
        //
        // toList
        //
        this.toList.Location = new System.Drawing.Point(0, 72);
        this.toList.Name = "to-list";
        this.toList.Size = new System.Drawing.Size(96, 30);
        this.toList.TabIndex = 2;
        this.toList.Text = "一覧へ";
        this.toList.UseVisualStyleBackColor = true;
        this.toList.Click += new System.EventHandler(this.toList_Click);
        //
        // DoneScreen
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.Controls.Add(this.title);
        this.Controls.Add(this.doneMessage);
        this.Controls.Add(this.toList);
        this.Name = "Done";
        this.Size = new System.Drawing.Size(592, 365);
        this.ResumeLayout(false);
        this.PerformLayout();
    }

    #endregion

    private System.Windows.Forms.Label title;
    private System.Windows.Forms.Label doneMessage;
    private System.Windows.Forms.Button toList;
}
